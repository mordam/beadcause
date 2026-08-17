/**
 * The AI system registry, and the gate that keeps it true — bc-eqn1.4.
 *
 * Two properties, and only the second one is unusual. The first is that every registered
 * system resolves to a card with all five fields on it, which is a completeness check: a
 * seventh agent kind added to `BASELINES` with no `intendedUse` is a registered AI system
 * with no documentation, and this is what says so.
 *
 * The second is the one worth reading. A card is only worth having if it is still true,
 * and documentation kept true by *expecting* somebody to update it is documentation that
 * stops being true on the first busy week. So `cardGap` refuses an amendment that changes
 * what an agent may do unless the card changes with it — and the checks below are written
 * to fail if that refusal is ever softened into a warning, because a gate that cannot
 * fail is one nobody should trust (test/css.mjs's rule, and it applies here).
 *
 * The static half deliberately reads the *code line* rather than the block around it.
 * Every file in this repo argues in prose that names its own identifiers, so a grep over
 * a region is routinely satisfied by the comment above the line it is guarding — see
 * lib/foundation.js, where `cardGap` is discussed at length in three separate comments
 * before it is ever called.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS,
  AMENDABLE,
  PROTECTED,
  CARD_FIELDS,
  CARD_IMPLICATIONS,
  cardGap,
  cardModel,
  cardOf,
  baseline,
} from '../lib/foundation.js';
import { SYSTEM, SYSTEMS, isSystem, systemCard, systemCards, registryGaps } from '../lib/systemcard.js';
import { parseAmendment } from '../lib/amendment.js';
import { FALLBACK_MODEL } from '../lib/complexity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

console.log('AI system registry\n');

/* ------------------------------------------------------------ the register */

await check('every registered system resolves to a card, and beadcause is one of them', () => {
  assert.ok(SYSTEMS.includes(SYSTEM), 'beadcause is a registered system, not only its agents');
  for (const agent of AGENTS) assert.ok(SYSTEMS.includes(agent), `${agent} is registered`);
  assert.equal(SYSTEMS.length, AGENTS.length + 1, 'the system itself, plus one per agent kind');
  for (const id of SYSTEMS) assert.equal(systemCard(id).id, id);
});

await check('but beadcause is not an agent — AGENTS still means agent kinds', () => {
  assert.ok(!AGENTS.includes(SYSTEM), 'a seventh key in BASELINES would make every reader of AGENTS wrong');
  assert.throws(() => baseline(SYSTEM), /unknown agent/, 'and there is no foundation to resolve for it');
  assert.ok(isSystem(SYSTEM) && isSystem('worker'), 'the registry answers for both');
  assert.ok(!isSystem('nonesuch'));
});

await check('no card is missing a field, and a new agent kind without one fails here', () => {
  assert.deepEqual(registryGaps(), [], 'every system carries all five card fields');

  // The check has to be able to fail. A fabricated card with a blank field stands in for
  // the seventh agent kind somebody adds to BASELINES next month.
  const blank = { ...baseline('worker'), oversight: '   ' };
  const missing = CARD_FIELDS.filter((f) => !String(cardOf(blank)[f] || '').trim());
  assert.deepEqual(missing, ['oversight'], 'an unset field is found by name, not merely counted');
});

await check('a card says something, rather than saying the field name back', () => {
  for (const id of SYSTEMS) {
    const card = systemCard(id);
    for (const field of CARD_FIELDS) {
      assert.ok(
        String(card[field]).trim().length >= 60,
        `${id}.${field} is a sentence somebody can act on, not a placeholder`
      );
    }
  }
});

await check("beadcause's own card answers the model question rather than leaving it blank", async () => {
  const card = systemCard(SYSTEM);
  assert.equal(card.model.model, null, 'a daemon does not run on a model');
  assert.equal(card.model.source, 'per-agent');
  assert.match(card.model.note, /agents/, 'and it says where the answer actually is');
  // The distinction that would otherwise be lost: an agent with no model set is routed
  // per bead and lands on the fallback, which is a different fact from "not applicable".
  assert.deepEqual(cardModel(baseline('worker')), { model: FALLBACK_MODEL, source: 'routed', routed: true });
  assert.deepEqual(cardModel({ model: 'haiku' }), { model: 'haiku', source: 'foundation', routed: false });
  assert.deepEqual(cardModel({ model: 'haiku', amended: ['model'] }), {
    model: 'haiku',
    source: 'amendment',
    routed: false,
  });
});

await check('the effective register is the baselines when nothing has been amended', async () => {
  const cards = await systemCards(ROOT);
  assert.deepEqual(cards.map((c) => c.id), SYSTEMS, 'the system first, then the agents in order');
  assert.deepEqual(cards[0], systemCard(SYSTEM), 'and nothing amends the system itself');
});

/* -------------------------------------------------------------- the fields */

await check('the card fields are amendable, and none of them is protected', () => {
  for (const field of CARD_FIELDS) {
    assert.ok(AMENDABLE.includes(field), `${field} is inside the amendment chain`);
    assert.ok(!PROTECTED.includes(field), `${field} is not locked to a release`);
  }
  // The judgement this bead owns, pinned so a later edit has to argue with it: a card
  // field outside AMENDABLE could change in a release with nothing on the ref to show
  // for it, which is the exact drift the register exists to prevent.
  assert.ok(AMENDABLE.length > 8, 'the card fields were added to the amendable set, not beside it');
});

/* ---------------------------------------------------------------- the gate */

await check('an amendment that moves a capability without the card is refused, by name', () => {
  for (const [field, implicates] of Object.entries(CARD_IMPLICATIONS)) {
    const gap = cardGap({ [field]: 'anything' });
    assert.ok(gap, `${field} on its own is refused`);
    assert.deepEqual(gap.gaps, [{ field, implicates }]);
    assert.ok(gap.message.includes(field), 'the refusal names the field that moved');
    for (const card of implicates) {
      assert.ok(gap.message.includes(card), `and names ${card}, so a maintainer can act on it`);
    }
  }
});

await check('and it is allowed the moment the card moves with it', () => {
  assert.equal(cardGap({ model: 'haiku', limitations: 'less of it' }), null);
  assert.equal(cardGap({ allowedTools: [], intendedUse: 'more of it' }), null);
  assert.equal(cardGap({ allowedTools: [], foreseeableMisuse: 'a new way to be wrong' }), null);
  assert.equal(cardGap({ permissionMode: 'acceptEdits', oversight: 'nobody approves each call now' }), null);
});

await check('two capabilities owe two sentences — the union would let one stand in for both', () => {
  const gap = cardGap({ model: 'haiku', permissionMode: 'acceptEdits', limitations: 'less of it' });
  assert.ok(gap, 'limitations covers the model and says nothing about the deleted control');
  assert.deepEqual(gap.gaps, [{ field: 'permissionMode', implicates: ['oversight'] }]);
  assert.equal(cardGap({ model: 'haiku', permissionMode: 'acceptEdits', limitations: 'x', oversight: 'y' }), null);
});

await check('an ungated field is not dragged in, and a card-only amendment is fine', () => {
  assert.equal(cardGap({ purpose: 'said differently' }), null, 'purpose is deliberately ungated');
  assert.equal(cardGap({ role: 'behave otherwise' }), null);
  assert.equal(cardGap({ env: {} }), null);
  assert.equal(cardGap({ timeoutMs: 1 }), null);
  assert.equal(cardGap({ intendedUse: 'a better sentence' }), null, 'documentation alone needs nothing');
  assert.equal(cardGap({}), null);
  assert.equal(cardGap(null), null);
});

/* -------------------------------------------------- and through a real request */

const REQUEST = (extra) => `
\`\`\`amendment
agent: advocate
kind: prohibited
scope: reading git blame in a repo I am already reading; no writes
justification: |
  The survey needed to know who last touched the file and could not ask, so it guessed at
  the author and was wrong about it in the proposal it filed.
${extra}add:
  allowedTools:
    - Bash(git blame:*)
\`\`\`
`;

await check('a request that widens an allowlist and leaves its card alone is refused at the parse', () => {
  const request = parseAmendment(REQUEST(''));
  assert.match(request.error, /refused/, 'and every caller keys off `error`, so none of them applies it');
  assert.match(request.error, /allowedTools/);
  assert.match(request.error, /intendedUse/);
  assert.deepEqual(request.cardGap.gaps, [
    { field: 'allowedTools', implicates: ['intendedUse', 'foreseeableMisuse'] },
  ]);
  // Errored *and* complete, the way a `beyond` request is: the argument is what makes the
  // refusal answerable, and dropping it on the floor is what this repo already learned
  // not to do.
  assert.match(request.scope, /git blame/);
  assert.match(request.justification, /guessed at/);
  assert.deepEqual(request.add.allowedTools, ['Bash(git blame:*)']);
});

await check('the same request, with the sentence it owes, parses clean', () => {
  const request = parseAmendment(
    REQUEST('set:\n  intendedUse: Surveying a repo, and now saying who last touched the file it proposes about.\n')
  );
  assert.equal(request.error, null);
  assert.equal(request.cardGap, undefined);
  assert.deepEqual(Object.keys(request.set), ['intendedUse']);
  assert.deepEqual(request.add.allowedTools, ['Bash(git blame:*)']);
});

await check('a `remove:` counts as moving the list, not only an `add:`', () => {
  const request = parseAmendment(`
\`\`\`amendment
agent: advocate
kind: omitted
scope: dropping the browser grant I never use
justification: |
  I have never once opened a page in four months of surveys, and a grant nobody uses is
  a grant nobody is reviewing either.
remove:
  allowedTools:
    - Bash(beadcause-browse:*)
\`\`\`
`);
  assert.match(request.error, /refused/, 'narrowing changes what the card describes just as widening does');
  assert.deepEqual(request.cardGap.gaps, [
    { field: 'allowedTools', implicates: ['intendedUse', 'foreseeableMisuse'] },
  ]);
});

/* ------------------------------------------------------ the commit is the funnel */

await check('the enforcement is on the write, not only on the parser', () => {
  // Scoped to the code line rather than the block: `cardGap` is named in three comments
  // in this file before it is ever called, so a region match here would pass over a
  // deleted call. Delete the two lines below in lib/foundation.js and this goes red.
  const src = read('lib/foundation.js');
  const lines = src.split('\n').map((l) => l.trim());
  assert.ok(
    lines.includes('const gap = cardGap(patch);'),
    '`validate` resolves the gap for the patch it is about to commit'
  );
  assert.ok(
    lines.some((l) => l.startsWith('if (gap) throw new Error(')),
    'and throws on it, so no future caller of `amend` walks past the gate'
  );

  // The pairing itself is a decision, not an implementation detail: every gated field is
  // one that changes what the agent can do, and every card field it points at exists.
  for (const [field, implicates] of Object.entries(CARD_IMPLICATIONS)) {
    assert.ok(AMENDABLE.includes(field), `${field} is a field an amendment can actually move`);
    for (const card of implicates) assert.ok(CARD_FIELDS.includes(card), `${card} is a card field`);
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
