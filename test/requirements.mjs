#!/usr/bin/env node
//
// The requirements corpus, the field on a bead, and the briefs that read them — bc-fvmx.
//
//   npm test                        (runs it alongside the other suites)
//   node test/requirements.mjs      (on its own)
//
// Nothing here touches git, a tracker, or the real architecture checkout: the corpus half
// runs against fixture text in the five shapes the real corpus actually uses, and the
// promotion half against a temp YAML file. The git-backed index has its own suite in
// test/reqindex.mjs.
//
// What is worth asserting, and why each one is here rather than assumed:
//
// 1. **Every shape in the corpus parses.** The reader is line-based *because* half of
//    these files are not valid YAML and none of them agree on a layout — so the fixtures
//    below are five real shapes, and a parser that quietly dropped one would turn every
//    id in that file into an "invention" the moment an advocate named it.
// 2. **An id that does not resolve is refused, and said out loud.** This is the whole
//    defence of the graph. Refused silently it repeats forever; kept it is a fabrication
//    with a bead's authority behind it.
// 3. **A candidate is never an id.** The two are stored apart, and a candidate that has
//    since been promoted collapses into the id rather than being proposed twice.
// 4. **An empty answer stays empty.** No corpus, no block, no section — every path that
//    could invent a heading over nothing.
// 5. **Promotion never rewrites what it did not add**, and refuses an unknown token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTreeSync } from './helpers/tmp.mjs';

const {
  parseCorpusText,
  loadCorpus,
  forgetCorpus,
  corpusDir,
  idsIn,
  isRequirement,
} = await import('../lib/requirements.js');
const { readRequirements, requirementsBlock, withRequirements, candidateId, hasRequirements } = await import('../lib/beadreqs.js');
const { requirementsSection } = await import('../lib/epicadvocate.js');
const { gleanSection, GLEAN_LABEL, withGlean, gleanRecord } = await import('../lib/reqglean.js');
const { requirementsBrief } = await import('../lib/reqbrief.js');
const { promotionFor, applyPromotion, promotionAsk, homeFor } = await import('../lib/reqpromote.js');
const { coverage, describeCoverage } = await import('../lib/reqcoverage.js');

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reqs-'));
process.on('exit', () => removeTreeSync(tmp));

/* --------------------------------------------------------------- the corpus */

console.log('the corpus, in every shape the real one uses');

// 1. Nested `definition:` under `requirements:` — auth-service.
const NESTED = `---
feature: authentication-service
description: A service
token: AS

requirements:
    AS.verify:
        definition: the service will provide \`POST /verify\` for verifying a credential.
    AS.unverified:
        definition: the service will return 401 for invalid credentials
`;

// 2. Block scalar plus a markdown spec link, and a list of them — energy-navigator.
const BLOCKS = `---
feature: Energy Navigator
description: a portal
token: EN

requirements:
  EN.HomeownerPortal.HiddenData:
    definition: |
        As a homeowner, when I hide my data, I expect my house to be displayed as grey.
    Test case: [HiddenData.spec.ts](https://github.com/Climative/test-automation/blob/main/HiddenData.spec.ts)

  EN.HomeownerPortal.PermissionsToggle:
    definition: |
        As a homeowner, I should be able to toggle permissions.
    Test case:
      - [PermissionsToggle1.spec.ts](https://example.invalid/a)
      - [ProfileDeleting.spec.ts](https://example.invalid/b)
`;

// 3. Top-level ids with inline definitions and no `requirements:` key — energy-navigator-backend.
const INLINE = `---
feature: Energy Navigator Backend
description: Backend
token: ENB
ENB.users.invitations.ProgramUserMembership.user-creation: for new users will include the membership selected.
`;

// 4. Two documents in one file, the second introduced by === — energy-advisor.
const TWO_DOCS = `---
feature: one
token: EAA

requirements:
    EAA.ServiceOrganization.homeownerAssignment.notification:
        definition: The Service Organization is notified.

===
feature: two
token: EA
reference: ./models/gold.yaml

requirements:
  EA.ManageUsers.Naming: User management is available under a tab named "Manage Users"
`;

// 5. Dotted-suffix nesting, and a bare-line definition — data-platform and service-area.
const NESTED_SUFFIX = `---
feature: sharing
token: CDPDS

requirements:
    CDPDS:
      .client:
          .auth:
              definition: CDP clients have access via an apiKey
      .access:
          definition: CDP clients can access data via Climative APIs
`;
const BARE = `---
feature: Service Area Management
token: SAM

Definitions:
  Site: A unique site.

Business requirements:
  SAM.business.interface:
    CRUD can be done by a person without extensive programming skills
`;

const parsed = new Map();
for (const [name, text] of [
  ['nested', NESTED],
  ['blocks', BLOCKS],
  ['inline', INLINE],
  ['two-docs', TWO_DOCS],
  ['suffix', NESTED_SUFFIX],
  ['bare', BARE],
]) {
  for (const [id, entry] of parseCorpusText(text, `${name}.yaml`)) parsed.set(id, entry);
}

check('a nested definition parses', parsed.get('AS.verify')?.definition?.startsWith('the service will provide'), String(parsed.get('AS.verify')?.definition));
check(
  'a block scalar is folded into one line',
  parsed.get('EN.HomeownerPortal.HiddenData')?.definition === 'As a homeowner, when I hide my data, I expect my house to be displayed as grey.',
  String(parsed.get('EN.HomeownerPortal.HiddenData')?.definition)
);
check(
  'one markdown spec link is kept with its name',
  parsed.get('EN.HomeownerPortal.HiddenData')?.specs?.[0]?.name === 'HiddenData.spec.ts',
  JSON.stringify(parsed.get('EN.HomeownerPortal.HiddenData')?.specs)
);
check(
  'a list of spec links is kept whole',
  parsed.get('EN.HomeownerPortal.PermissionsToggle')?.specs?.length === 2,
  JSON.stringify(parsed.get('EN.HomeownerPortal.PermissionsToggle')?.specs)
);
check(
  'a top-level id with an inline definition parses',
  parsed.get('ENB.users.invitations.ProgramUserMembership.user-creation')?.definition?.startsWith('for new users'),
  String(parsed.get('ENB.users.invitations.ProgramUserMembership.user-creation')?.definition)
);
check('a second document in one file gets its own token', parsed.get('EA.ManageUsers.Naming')?.token === 'EA', String(parsed.get('EA.ManageUsers.Naming')?.token));
check('and the first document is still there', parsed.has('EAA.ServiceOrganization.homeownerAssignment.notification'));
check('dotted suffixes compose into one id', parsed.get('CDPDS.client.auth')?.definition === 'CDP clients have access via an apiKey', JSON.stringify(parsed.get('CDPDS.client.auth')));
check('the heading they hang off is not itself a requirement', !parsed.has('CDPDS') && !parsed.has('CDPDS.client'));
check('a bare line under an id is its definition', parsed.get('SAM.business.interface')?.definition?.startsWith('CRUD can be done'), String(parsed.get('SAM.business.interface')?.definition));

// The template file, which must yield nothing at all: its "token" is a placeholder, and a
// corpus that accepted it would hand every caller placeholder ids to validate against.
const TEMPLATE = `--- # Work In Progress
feature: <some feature name>>
token: <SOME_ALPHABETA_TOKEN_NO_SPACES>

requirements:
    <SOME_ALPHABETA_TOKEN_NO_SPACES>--<SomeFeatureRequirementName>:
        definition: <what is the requirement>
`;
check('the template file yields no requirements', parseCorpusText(TEMPLATE, 'example-template.yaml').size === 0);

// An id written down with no definition yet is a stub, not an invention: it is in the
// corpus, so naming it must not be refused.
const STUB = `---
feature: rules
token: IBR

requirements:
    IBR.fuel-type-x:
        definition:
`;
const stubbed = parseCorpusText(STUB, 'stub.yaml');
check('an id with no definition survives as a stub', stubbed.get('IBR.fuel-type-x')?.stub === true, JSON.stringify(stubbed.get('IBR.fuel-type-x')));

// Three shapes found by the session that raced this one on bc-fvmx.1, each verified
// against the real corpus. They are here rather than in a note because all three fail the
// same way — quietly, as a requirement that reads like one nobody has written yet.

// 1. A definition written as a list under an empty `definition:` — athena. Read strictly
//    these are stubs, and a stub says "nobody has written this", which is the opposite of
//    the truth: three paragraphs of it are right there on the next line.
const LIST_DEF = `---
feature: Athena
token: AREA

requirements:
    AREA.application.personas:
        definition:
            - Admin: Manages users, roles, and permissions.
            - Author: Creates and manages rulesets.
    AREA.ruleset.management:
        definition:
`;
const listed = parseCorpusText(LIST_DEF, 'athena.yaml');
check('a definition written as a list is read, not filed as a stub', /Admin: Manages users/.test(listed.get('AREA.application.personas')?.definition || ''), JSON.stringify(listed.get('AREA.application.personas')));
check('and an empty key with nothing under it is still a stub', listed.get('AREA.ruleset.management')?.stub === true);

// 2. A `Test case:` indented *into* the definition block — EN.SignIn.Options. The block
//    scalar swallows it, so the corpus's 18 `Test case` keys used to yield 17 specs, and
//    one definition carried a markdown URL glued to its last sentence.
const NESTED_SPEC = `---
feature: Energy Navigator
token: EN

requirements:
  EN.SignIn.Options:
    definition: |
        An authenticated user is presented with the ClimativeMap options.
        Test case: [SignInOptions.spec.ts](https://example.invalid/a)
`;
const nestedSpec = parseCorpusText(NESTED_SPEC, 'en.yaml').get('EN.SignIn.Options');
check('a Test case indented into the definition is still a spec', nestedSpec?.specs?.[0]?.name === 'SignInOptions.spec.ts', JSON.stringify(nestedSpec?.specs));
check('and it is trimmed off the definition rather than left in it', nestedSpec?.definition === 'An authenticated user is presented with the ClimativeMap options.', String(nestedSpec?.definition));

/* ------------------------------------------------------- a corpus on disk */

console.log('\nreading a corpus off a disk');

const corpusRoot = path.join(tmp, 'architecture', 'resources', 'reqs');
fs.mkdirSync(path.join(corpusRoot, 'product'), { recursive: true });
fs.mkdirSync(path.join(corpusRoot, 'technical'), { recursive: true });
fs.writeFileSync(path.join(corpusRoot, 'product', 'en.product-requirements.yaml'), BLOCKS);
fs.writeFileSync(path.join(corpusRoot, 'technical', 'as.technical-requirements.yaml'), NESTED);
forgetCorpus();

const corpus = loadCorpus(path.join(tmp, 'architecture'));
check('a checkout root resolves to its resources/reqs', corpus.dir === corpusRoot, String(corpus.dir));
check('every file is read', corpus.ids.size === 4, String(corpus.ids.size));
check('tokens are listed', corpus.tokens.join(',') === 'AS,EN', corpus.tokens.join(','));
check('an absent directory is an answer, not a throw', loadCorpus(path.join(tmp, 'nope')).ids.size === 0);

// 3. One id defined in two files — `AS.authentication` is in both audit-service and
//    auth-service, which both declare `token: AS`. First writer wins, because last-writer
//    would make the answer depend on readdir order; but winning *quietly* leaves the other
//    requirement invisible with nothing anywhere saying a choice was made.
fs.writeFileSync(
  path.join(corpusRoot, 'technical', 'as-audit.technical-requirements.yaml'),
  '---\nfeature: audit\ntoken: AS\n\nrequirements:\n    AS.verify:\n        definition: a different definition of the same id\n'
);
forgetCorpus();
const clashed = loadCorpus(path.join(tmp, 'architecture'));
check('an id defined twice is reported rather than silently resolved', clashed.duplicates.length === 1 && clashed.duplicates[0].id === 'AS.verify', JSON.stringify(clashed.duplicates));
check('and the first file read still wins', clashed.ids.get('AS.verify')?.file === clashed.duplicates[0].kept, String(clashed.ids.get('AS.verify')?.file));
fs.unlinkSync(path.join(corpusRoot, 'technical', 'as-audit.technical-requirements.yaml'));
forgetCorpus();
check('and so is no directory at all', loadCorpus(null).ids.size === 0);
check('corpusDir finds it from a repo dir', corpusDir({}, [path.join(tmp, 'architecture')]) === corpusRoot, String(corpusDir({}, [path.join(tmp, 'architecture')])));
check('config wins when it names one', corpusDir({ requirements: { corpus: corpusRoot } }, []) === corpusRoot);

check('an id in prose is found', idsIn('this implements EN.HomeownerPortal.HiddenData today', corpus)[0] === 'EN.HomeownerPortal.HiddenData');
check(
  'and a word shaped like one is not',
  idsIn('see lib.advocate.js and EN.Nope.Nope for this', corpus).length === 0,
  JSON.stringify(idsIn('see lib.advocate.js and EN.Nope.Nope', corpus))
);

/* ------------------------------------------------------- the field on a bead */

console.log('\nwhat a bead says it fulfils');

const candidate = { token: 'EN', name: 'HomeownerPortal.Exported', definition: 'As a homeowner, I want to export my data.' };
const block = requirementsBlock({ ids: ['AS.verify', 'EN.Invented.Thing'], candidates: [candidate] });
const bead = { id: 'bc-1', notes: `some prose about the work\n\n${block}` };
const read = readRequirements(bead, corpus);

check('a resolving id is kept', read.ids.includes('AS.verify'), JSON.stringify(read.ids));
check('an id that is not in the corpus is refused', !read.ids.includes('EN.Invented.Thing'), JSON.stringify(read.ids));
check('and it is reported rather than silently dropped', read.dropped.includes('EN.Invented.Thing'), JSON.stringify(read.dropped));
check('a candidate is kept apart from the ids', read.candidates.length === 1 && candidateId(read.candidates[0]) === 'EN.HomeownerPortal.Exported');
check('a candidate with no definition is not a candidate', requirementsBlock({ candidates: [{ token: 'EN', name: 'X' }] }) === '');
check('an empty payload writes no block at all', requirementsBlock({}) === '');
check('a bead with no block reads empty and does not throw', readRequirements({ notes: 'nothing here' }, corpus).ids.length === 0);
check('and so does no bead at all', readRequirements(null, corpus).ids.length === 0);
check('hasRequirements sees the block', hasRequirements(bead) && !hasRequirements({ notes: 'plain' }));

// With no corpus there is nothing to check against, and refusing everything would turn a
// missing checkout into data loss on the next write.
check('no corpus drops nothing', readRequirements(bead, null).ids.length === 2, JSON.stringify(readRequirements(bead, null).ids));

// A candidate that has since been promoted is an id, not a proposal. Built as a separate
// object rather than by mutating `corpus`: `loadCorpus` hands out its cached value, so a
// test that wrote into it would be changing what every later assertion here sees.
const promotedCorpus = {
  ...corpus,
  ids: new Map([...corpus.ids, ['EN.HomeownerPortal.Exported', { id: 'EN.HomeownerPortal.Exported', token: 'EN', definition: 'exported', specs: [] }]]),
};
const afterPromotion = readRequirements(bead, promotedCorpus);
check('a promoted candidate collapses into the ids', afterPromotion.ids.includes('EN.HomeownerPortal.Exported') && !afterPromotion.candidates.length, JSON.stringify(afterPromotion));

const spliced = withRequirements(bead.notes, { ids: ['AS.unverified'], candidates: [] });
check('rewriting replaces rather than accretes', (spliced.match(/beadcause:requirements/g) || []).length === 2, spliced);
check('and the prose around it survives', spliced.includes('some prose about the work'));
check('an empty payload removes the block', !withRequirements(bead.notes, {}).includes('beadcause:requirements'));

/* ------------------------------------------------------------- the briefs */

console.log('\nwhat the briefs say');

const section = requirementsSection(bead, corpus);
check('the advocate is shown what resolves', section.includes('AS.verify'));
check('and told what it wrote that does not exist', section.includes('EN.Invented.Thing') && section.includes('does not exist'));
check('the vocabulary is named', section.includes('AS, EN'));
check('and an empty answer is made cheap', section.includes('Leave it out entirely if nothing applies'));
check('a bead naming nothing is not told to fix that', requirementsSection({ id: 'bc-2' }, corpus).includes('is not something to fix'));
check('no corpus, no section', requirementsSection(bead, null) === '');

const pending = [{ bead: 'bc-1.4', title: 'a thing', commit: 'abcdef1234', files: ['lib/a.js', 'lib/b.js'] }];
const glean = gleanSection(pending, corpus.tokens);
check('the glean ask names the commit and the files', glean.includes('abcdef12') && glean.includes('lib/a.js'));
check('it says the label is the queue', glean.includes(GLEAN_LABEL));
check('it refuses to let the agent mint an id', glean.includes('may not mint a requirement id'));
check('and nothing owed is no section', gleanSection([], corpus.tokens) === '');

const gleanNotes = withGlean('prose', { commit: 'abcdef1234567', files: ['lib/a.js'] });
check('the glean record round-trips off the bead', gleanRecord({ notes: gleanNotes })?.commit === 'abcdef1234567', gleanNotes);
check('a bead with no record reads null', gleanRecord({ notes: 'prose' }) === null);

const matches = [{ id: 'EN.HomeownerPortal.HiddenData', files: ['public/app.js'], edges: [{ provenance: 'observed-from-diff' }] }];
const brief = requirementsBrief(matches, corpus, { source: 'declared' });
check('the worker brief quotes the definition', brief.includes('I expect my house to be displayed as grey'));
check('and names the spec that covers it', brief.includes('HiddenData.spec.ts'));
check('it says silence is not a claim', brief.includes('not a complete list'));
check('nothing matched is no section', requirementsBrief([], corpus) === '');

/* ------------------------------------------------------------- promotion */

console.log('\npromotion');

const ok = promotionFor(candidate, corpus);
check('a candidate under a real token promotes', ok.ok && ok.id === 'EN.HomeownerPortal.Exported', JSON.stringify(ok));
check('into the file that token already lives in', ok.file === 'product/en.product-requirements.yaml', String(ok.file));
check('an unknown token is refused', promotionFor({ token: 'ZZZ', name: 'A', definition: 'x' }, corpus).why.includes('token'));
check('an id that already exists is refused', promotionFor({ token: 'AS', name: 'verify', definition: 'x' }, corpus).why.includes('already exists'));
check('homeFor picks the file with the most of that token', homeFor(corpus, 'AS') === 'technical/as.technical-requirements.yaml');

const ask = promotionAsk(ok, { bead: 'bc-1', workspace: 'beadcause' });
check('the question carries the exact block', ask.body.includes('EN.HomeownerPortal.Exported:') && ask.body.includes('definition:'));
check('and says nothing has been written', ask.body.includes('Nothing has been written'));

const before = fs.readFileSync(path.join(corpusRoot, 'product', 'en.product-requirements.yaml'), 'utf8');
const applied = applyPromotion(corpusRoot, ok);
const after = fs.readFileSync(path.join(corpusRoot, 'product', 'en.product-requirements.yaml'), 'utf8');
check('applying writes the block', applied.written && after.includes('EN.HomeownerPortal.Exported:'), JSON.stringify(applied));
check('and changes nothing that was already there', before.split('\n').every((l) => after.includes(l)));
forgetCorpus();
const reloaded = loadCorpus(path.join(tmp, 'architecture'));
check('the corpus reads the new id back', isRequirement(reloaded, 'EN.HomeownerPortal.Exported'), [...reloaded.ids.keys()].join(','));
check('applying twice is refused rather than duplicated', applyPromotion(corpusRoot, ok).written === false);

/* -------------------------------------------------------------- coverage */

console.log('\ncoverage, said honestly');

const graph = {
  'AS.verify': [{ commit: 'a1', provenance: 'observed-from-diff', files: ['lib/auth.js'] }],
  'EN.HomeownerPortal.HiddenData': [{ commit: 'b2', provenance: 'declared', files: ['public/app.js'] }],
  'GONE.Old.Thing': [{ commit: 'c3', provenance: 'declared', files: [] }],
};
const cov = coverage(reloaded, graph);
check('covered counts only requirements with an edge', cov.totals.covered === 2, JSON.stringify(cov.totals));
check('observed counts only the ones a merge proved', cov.totals.observed === 1, JSON.stringify(cov.totals));
check('an id the corpus no longer has is reported as an orphan', cov.orphans.length === 1 && cov.orphans[0].id === 'GONE.Old.Thing');
check('the sentence always states the denominator', describeCoverage(cov).includes(`of ${cov.totals.total} requirements`), describeCoverage(cov));
check('no corpus says so rather than claiming 100%', describeCoverage(coverage(null, {})).includes('no requirements corpus'));

/* ------------------------------------------------------------ never a gate */

console.log('\nnothing consults the graph for permission');

// The one property that cannot be asserted by calling anything, because it is about what
// is *not* wired up: no path that decides whether work may be dispatched, held or edited
// may read the requirement index. Coverage is partial by construction, so a graph that
// could withhold work would withhold it for the wrong reason — lib/beadfiles.js's rule
// that a guess must not hold a bead, applied to something with far less evidence behind
// it. Asserted at the import boundary, which is where it would actually be broken: the
// first person to reach for `edgesForFiles` inside a hold predicate has to change this
// list and say why.
const LIB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib');
const READERS = new Set(['reqbrief.js', 'reqcoverage.js', 'reqlanding.js', 'server.js']);
const importers = [];
for (const file of fs.readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(LIB, file), 'utf8');
  if (/from '\.\/reqindex\.js'/.test(src)) importers.push(file);
}
check(
  'only the reader, the recorder, the coverage view and the server touch the index',
  importers.length && importers.every((f) => READERS.has(f)),
  importers.join(', ')
);

// And the dispatch side specifically: the advocate may record a landing, and may not look
// the graph up to decide anything.
const advocate = fs.readFileSync(path.join(LIB, 'advocate.js'), 'utf8');
check(
  'the advocate records landings but never queries the graph',
  !/from '\.\/reqindex\.js'/.test(advocate) && /from '\.\/reqlanding\.js'/.test(advocate)
);
check(
  'and lib/beadfiles.js, which decides holds, knows nothing about requirements',
  !/req(index|brief|uirements)\.js/.test(fs.readFileSync(path.join(LIB, 'beadfiles.js'), 'utf8'))
);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
