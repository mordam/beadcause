#!/usr/bin/env node
//
// The control corpus — SOC 2, 27001, 42001, 23894, 42005 and 5338 in one closed
// vocabulary — bc-4r10.1, and the management-system clauses from bc-eqn1.2.
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
// 1. **The counts are pinned.** 61 + 93 + 38 + 32 + 22 + 16 + 31. The 2022 revision of
//    27001 consolidated 114 controls into 93; a corpus that quietly regrew to 114, or lost
//    eleven in an edit, would keep validating ids and every report over it would still look
//    fine.
// 2. **A local id collides across frameworks and must not collide in the corpus.** `A.5.2`
//    is roles-and-responsibilities in 27001 and the impact assessment process in 42001.
//    This is the single reason the framework token is inside the id, so it is tested.
// 3. **The crosswalk is closed in both directions.** An edge to an id nobody minted is
//    refused at build time; here that refusal is exercised rather than trusted.
// 4. **The inverse is exactly the inverse.** `satisfiedBy` is computed, and a computed
//    index that has drifted from what it was computed from is worse than no index.
// 5. **The gap is an exact list.** Twelve SOC 2 criteria have no inbound edge, all of them
//    27701 territory. Pinned, because the failure mode this whole file guards against is
//    somebody making the matrix look full — and the honest fix (27701) will change this
//    list, and should have to say so. It was fifteen until the 42001 clauses landed; the
//    three that moved are pinned individually, against the clauses that claim them, so that
//    "the gap shrank" can never be true without saying how.
// 6. **An id nobody minted is refused and said out loud.** Dropped silently, an advocate
//    writes the same invented control every run.
// 7. **The kind is on the record and one framework holds two of them.** `ISO42001.Clause8.3`
//    and `ISO42001.A.6.2.8` are both real and are audited in ways with nothing in common,
//    so a corpus that flattened them back to one kind would let a filing cabinet be counted
//    as a control set.
// 8. **A guidance standard is never cited by a clause number.** Asserted as a property of
//    every id rather than left as a convention: certifiable frameworks quote numbering,
//    the three guidance ones name their subject and carry no digits at all.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  FRAMEWORKS,
  FRAMEWORK_TOKENS,
  KINDS,
  corpus,
  control,
  isControl,
  byFramework,
  byKind,
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

check('exactly six frameworks', FRAMEWORK_TOKENS.length === 6, FRAMEWORK_TOKENS.join(', '));
check(
  'every framework declares a token equal to its key, a name, an edition, its kinds and whether anybody certifies against it',
  FRAMEWORK_TOKENS.every((t) => {
    const f = FRAMEWORKS[t];
    return f.token === t && f.name && f.edition && typeof f.certifiable === 'boolean'
      && Array.isArray(f.kinds) && f.kinds.length && f.kinds.every((k) => KINDS.includes(k));
  })
);
check('exactly four kinds, and every one of them is held by somebody', KINDS.length === 4 && KINDS.every((k) => byKind(k).length > 0), KINDS.map((k) => `${k}:${byKind(k).length}`).join(' '));
check('SOC 2 holds criteria, 27001 holds controls, and 42001 holds both controls and clauses', JSON.stringify(FRAMEWORKS.SOC2.kinds) === '["criterion"]' && JSON.stringify(FRAMEWORKS.ISO27001.kinds) === '["control"]' && JSON.stringify(FRAMEWORKS.ISO42001.kinds) === '["control","clause"]');
check('the three guidance standards hold processes and nobody is certified against them', ['ISO23894', 'ISO42005', 'ISO5338'].every((t) => FRAMEWORKS[t].certifiable === false && JSON.stringify(FRAMEWORKS[t].kinds) === '["process"]'));
check('and the three that are certified against are the three anybody issues a certificate for', FRAMEWORK_TOKENS.filter((t) => FRAMEWORKS[t].certifiable).join(' ') === 'SOC2 ISO27001 ISO42001');
check('a token nobody minted is not a framework', frameworkOf('NIST80053.AC-2') === null && byFramework('NIST80053').length === 0);
check('the token in a real id resolves', frameworkOf('ISO27001.A.8.3') === 'ISO27001');

/* ------------------------------------------------------------------ the counts */

console.log('\nthe counts, pinned');

check('61 Trust Services Criteria', byFramework('SOC2').length === 61, String(byFramework('SOC2').length));
check('93 ISO/IEC 27001:2022 Annex A controls', byFramework('ISO27001').length === 93, String(byFramework('ISO27001').length));
check('38 ISO/IEC 42001:2023 Annex A controls and 32 management-system clauses, under one token', byFramework('ISO42001').length === 70 && byKind('control').filter((r) => r.framework === 'ISO42001').length === 38 && byKind('clause').length === 32, String(byFramework('ISO42001').length));
check('22 ISO/IEC 23894 risk processes', byFramework('ISO23894').length === 22, String(byFramework('ISO23894').length));
check('16 ISO/IEC 42005 impact-assessment topics', byFramework('ISO42005').length === 16, String(byFramework('ISO42005').length));
check('31 ISO/IEC 5338 life cycle processes', byFramework('ISO5338').length === 31, String(byFramework('ISO5338').length));
check('293 records in one corpus, and the index agrees with the tables', C.size === 293 && C.ids.size === 293, String(C.size));
check('every record is in exactly one framework list and exactly one kind list', FRAMEWORK_TOKENS.reduce((n, t) => n + byFramework(t).length, 0) === C.size && KINDS.reduce((n, k) => n + byKind(k).length, 0) === C.size);

// The clauses, by their own groups. Clause 6 is Planning and clause 8 is Operation; a
// corpus that lost the risk-treatment clause would still have the right total if Annex A
// grew, and the Statement of Applicability is the one thing 42001 certifies against.
const clause = (n) => byKind('clause').filter((r) => r.group === `Clause${n}`).length;
check('the clauses are 4+3+6+7+4+6+2 across clauses 4 to 10', [4, 5, 6, 7, 8, 9, 10].map(clause).join('/') === '4/3/6/7/4/6/2', [4, 5, 6, 7, 8, 9, 10].map(clause).join('/'));
check('every clause belongs to a clause group and no clause escaped into an Annex A one', byKind('clause').every((r) => r.framework === 'ISO42001' && /^Clause\d+$/.test(r.group)));

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
check('carries a kind from the closed set, and one its framework declares it may hold', [...C.ids.values()].every((r) => KINDS.includes(r.kind) && FRAMEWORKS[r.framework].kinds.includes(r.kind)));
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

/* ---------------------------------------------- two kinds of thing under one token */

console.log('\nthe clauses and the controls, under one token and not conflated');

check(
  'a clause and an Annex A control are both real ids in 42001, with different kinds',
  control('ISO42001.Clause8.3')?.kind === 'clause' && control('ISO42001.A.6.2.8')?.kind === 'control'
);
check(
  'clause 8.3 is risk treatment and A.8.3 is external reporting — one token, one digit apart, two things',
  control('ISO42001.Clause8.3').title !== control('ISO42001.A.8.3').title,
  `${control('ISO42001.Clause8.3').title} vs ${control('ISO42001.A.8.3').title}`
);
// The group-key collision the `Clause` prefix exists to prevent. Grouped on the bare number,
// clause 6 (Planning) and Annex A group 6 (AI system life cycle) would have been one entry
// and every report over the corpus would have shown one of them under the other name.
check(
  'the clause groups and the Annex A groups do not collide, though their numbers do',
  control('ISO42001.Clause6.2').group === 'Clause6' && control('ISO42001.A.6.2.2').group === '6'
    && control('ISO42001.Clause6.2').groupName === 'Planning' && control('ISO42001.A.6.2.2').groupName === 'AI system life cycle'
);
check(
  'byKind answers across frameworks — every clause regardless of who wrote it down',
  byKind('clause').length === 32 && byKind('process').length === 69 && byKind('control').length === 131 && byKind('criterion').length === 61,
  KINDS.map((k) => `${k}:${byKind(k).length}`).join(' ')
);
check('a kind nobody minted is an empty list, not undefined', Array.isArray(byKind('policy')) && byKind('policy').length === 0 && byKind().length === 0);

// The header rule, made checkable rather than left as a convention: a certificate, a
// Statement of Applicability and an audit finding all cite a clause *number*, so an id in a
// certifiable framework quotes numbering. Nothing anybody signs cites 23894, 42005 or 5338,
// so those name their subject — and a digit appearing in one of them would be this corpus
// asserting a numbering nobody in this repo can check.
check(
  'every id in a certifiable framework quotes the numbering of its standard',
  [...C.ids.values()].filter((r) => FRAMEWORKS[r.framework].certifiable).every((r) => /\d/.test(r.local))
);
check(
  'and no id in a guidance framework carries a digit at all — they name a subject, never a clause',
  [...C.ids.values()].filter((r) => !FRAMEWORKS[r.framework].certifiable).every((r) => !/\d/.test(r.local)),
  [...C.ids.values()].filter((r) => !FRAMEWORKS[r.framework].certifiable && /\d/.test(r.local)).map((r) => r.id).join(' ')
);

/* ------------------------------------------------------------------ the crosswalk */

console.log('\nthe crosswalk');

const declared = [...C.ids.values()].flatMap((r) => r.crosswalk.map((t) => [r.id, t]));
check('346 declared edges, and every one of them resolves', declared.length === C.edges && declared.every(([, t]) => isControl(t)), String(declared.length));
check('no edge points at itself', declared.every(([from, to]) => from !== to));
check(
  'edges live on everything except criteria — no criterion declares one',
  byKind('criterion').every((r) => r.crosswalk.length === 0)
);
check(
  'and every non-criterion record declares at least one, so none is a dead end',
  [...C.ids.values()].filter((r) => r.kind !== 'criterion').every((r) => r.crosswalk.length),
  [...C.ids.values()].filter((r) => r.kind !== 'criterion' && !r.crosswalk.length).map((r) => r.id).join(' ')
);
check(
  '42001 reaches 27001 as well as SOC 2 — the same implementation under three names',
  crosswalk('ISO42001.A.6.2.8').includes('ISO27001.A.8.15') && crosswalk('ISO42001.A.6.2.8').includes('SOC2.CC7.2')
);
check(
  'a clause reaches the Annex A control that implements it, and the inverse says so',
  crosswalk('ISO42001.Clause5.2').includes('ISO42001.A.2.2') && satisfiedBy('ISO42001.A.2.2').includes('ISO42001.Clause5.2')
);
check(
  'the guidance standards reach the clause they elaborate — 23894 says what a 6.1.2 risk process contains',
  satisfiedBy('ISO42001.Clause6.1.2').filter((id) => id.startsWith('ISO23894.')).length >= 4,
  satisfiedBy('ISO42001.Clause6.1.2').join(' ')
);
check(
  'and 42005 says what a 6.1.4 impact assessment contains',
  satisfiedBy('ISO42001.A.5.4').filter((id) => id.startsWith('ISO42005.')).length >= 3,
  satisfiedBy('ISO42001.A.5.4').join(' ')
);
check(
  'no guidance record is pointed at by anything — guidance is cited, never claimed as a control',
  [...C.ids.values()].filter((r) => !FRAMEWORKS[r.framework].certifiable).every((r) => satisfiedBy(r.id).length === 0)
);
// The other half of that rule, and the one a well-meaning edit would break: guidance reaches
// a criterion through the control that implements it, never directly, so `satisfiedBy` on a
// criterion only ever lists things somebody could actually be audited against.
check(
  'and no guidance record claims a criterion directly',
  [...C.ids.values()].filter((r) => !FRAMEWORKS[r.framework].certifiable).every((r) => r.crosswalk.every((t) => control(t).kind !== 'criterion')),
  [...C.ids.values()].filter((r) => !FRAMEWORKS[r.framework].certifiable).flatMap((r) => r.crosswalk.filter((t) => control(t).kind === 'criterion').map((t) => `${r.id}->${t}`)).join(' ')
);
check(
  'nothing that claims a criterion is guidance — every claimer is a control or a clause',
  byKind('criterion').every((r) => satisfiedBy(r.id).every((from) => FRAMEWORKS[control(from).framework].certifiable))
);
check(
  'and the two-hop answer is still there — 5338 verification reaches CC8.1 through the 42001 control',
  crosswalk('ISO5338.Technical.Verification').includes('ISO42001.A.6.2.4') && crosswalk('ISO42001.A.6.2.4').includes('SOC2.PI1.3')
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
check('an id with nothing pointing at it answers with an empty list, not undefined', Array.isArray(satisfiedBy('SOC2.P6.1')) && satisfiedBy('SOC2.P6.1').length === 0);

/* ------------------------------------------------------------------- the gap list */

console.log('\nthe gap, stated rather than papered over');

// One reason left, and it is 27701. The other three closed when the clauses landed, and
// they are pinned individually below against the clause that claims each — so "the gap
// shrank" can never be recorded without saying which clause did it.
const PRIVACY_27701_TERRITORY = [
  'SOC2.PI1.4', 'SOC2.PI1.5',
  'SOC2.P2.1', 'SOC2.P3.2', 'SOC2.P5.1', 'SOC2.P5.2',
  'SOC2.P6.1', 'SOC2.P6.2', 'SOC2.P6.3', 'SOC2.P6.4', 'SOC2.P6.5', 'SOC2.P6.7',
];
assert.equal(PRIVACY_27701_TERRITORY.length, 12);

// bc-eqn1.2: the three that moved, and what claims each. Not one of them is reachable from
// Annex A in either ISO standard, which is why they were unclaimed at all — a clause claims
// them or nothing honestly does.
const CLOSED_BY_CLAUSE = {
  'SOC2.CC1.2': 'ISO42001.Clause5.1',
  'SOC2.CC3.3': 'ISO42001.Clause6.1.2',
  'SOC2.CC5.2': 'ISO42001.Clause6.1.3',
};

check(
  'exactly twelve criteria have no inbound edge, and they are exactly these twelve',
  JSON.stringify(unclaimed('SOC2')) === JSON.stringify(PRIVACY_27701_TERRITORY),
  unclaimed('SOC2').join(' ')
);
check(
  'no common criterion is unclaimed any more — the whole remaining gap is the elective privacy categories',
  unclaimed('SOC2').filter((id) => control(id).group === 'CC').length === 0
);
check(
  'and the three that used to be are each claimed by the named clause, not by anything stretched to reach them',
  Object.entries(CLOSED_BY_CLAUSE).every(([criterion, clauseId]) => satisfiedBy(criterion).includes(clauseId)),
  Object.entries(CLOSED_BY_CLAUSE).filter(([c, cl]) => !satisfiedBy(c).includes(cl)).map(([c]) => c).join(' ')
);
check(
  'each of the three is claimed by a clause and by no Annex A control, which is why it was a gap',
  Object.keys(CLOSED_BY_CLAUSE).every((id) => satisfiedBy(id).every((from) => control(from).kind === 'clause')),
  Object.keys(CLOSED_BY_CLAUSE).map((id) => `${id}<-${satisfiedBy(id).join(',')}`).join(' ')
);
check(
  'every common criterion is claimed by at least one ISO control or clause',
  cc.every((r) => satisfiedBy(r.id).length > 0),
  cc.filter((r) => !satisfiedBy(r.id).length).map((r) => r.id).join(' ')
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
// The shapes bc-eqn1.2 added. A token added to FRAMEWORKS and forgotten in the prose
// matcher is the silent half-failure: the corpus resolves the id and nothing ever finds it
// written down, so a bead declaring it looks like a bead declaring nothing.
check(
  'a clause id and a named guidance id are both found in prose',
  JSON.stringify(controlsIn('planned under ISO42001.Clause6.1.3, following ISO23894.Process.RiskTreatment and ISO5338.Technical.ContinuousValidation.'))
    === JSON.stringify(['ISO42001.Clause6.1.3', 'ISO23894.Process.RiskTreatment', 'ISO5338.Technical.ContinuousValidation']),
  JSON.stringify(controlsIn('planned under ISO42001.Clause6.1.3, following ISO23894.Process.RiskTreatment and ISO5338.Technical.ContinuousValidation.'))
);
check(
  'every framework token is reachable from prose, so no table is invisible to controlsIn',
  FRAMEWORK_TOKENS.every((t) => controlsIn(`see ${byFramework(t)[0].id} for this`).length === 1),
  FRAMEWORK_TOKENS.filter((t) => controlsIn(`see ${byFramework(t)[0].id} for this`).length !== 1).join(' ')
);
check('a clause number nobody minted is refused like any other invention', !isControl('ISO42001.Clause11.1') && !isControl('ISO42005.Clause6.4.3') && controlsIn('under ISO42005.Clause6.4.3').length === 0);

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
