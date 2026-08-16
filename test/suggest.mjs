#!/usr/bin/env node
/**
 * lib/suggest.js — the buttons a question gets when nobody wrote it any.
 *
 *     npm test
 *     node test/suggest.mjs
 *
 * Pure parsing, no network, no temp files. Worth pinning hard, because this is
 * the one place in the app where a *machine* decides what Adam's answer might
 * say, and both ways of being wrong are expensive:
 *
 * 1. **A star on the wrong chip.** "Rebuild from scratch — not recommended" is
 *    ordinary prose, and a ★ on it is the app recommending the thing the brief
 *    warned him off. Tested from both ends: the marker fires, and its negation
 *    beats it.
 *
 * 2. **Buttons on a list that was never a set of answers.** Silence is the
 *    correct output for almost every bead, and the rejections are the feature —
 *    a checklist, a fenced transcript, one lonely item, two candidate lists with
 *    nothing to choose between them. Each is pinned, because each of them is one
 *    loosened regex away from putting six chips on a card that has no question.
 *
 * 3. **A suggestion that sends itself.** These words came out of a paragraph, so
 *    the client fills the answer box with them and Adam presses the button. The
 *    last check in this file reads public/app.js and fails if the `suggest`
 *    handler ever learns to call submit().
 *
 * And one thing that is not about correctness at all: bd stores a description
 * hard-wrapped at about 78 columns, so a real option arrives as three physical
 * lines. Every fixture below that matters is written wrapped, because a parser
 * that only passes on unwrapped text passes on no bead in the tracker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { suggestOptions, suggestFromSections } = await import(LIB('suggest.js'));
const { toQuestion, parseDecision } = await import(LIB('decision.js'));

const labels = (r) => (r || []).map((o) => o.label);
const starred = (r) => (r || []).filter((o) => o.recommended).map((o) => o.label);
const show = (r) => JSON.stringify(r, null, 1);

/* ------------------------------------------------------- the shapes it reads */

console.log('\nshapes that become buttons');

// Written the way bd stores it: hard-wrapped, continuation lines indented.
const BOLD = `Merging main into the branch put the terminal and the swap in one
process for the first time, and they interact.

- **Restore at promotion** — move restoreTerminals() out of startup and into
  /internal/activate, so a promoted backend's list is read fresh. Costs a
  directory read on the critical path of a swap.
- **Restore at startup** — leave it where it is and rely on the reaper gating
  alone. A slightly stale list after promotion is acceptable. (recommended)`;

const bold = suggestOptions(BOLD);
check('a bold-led list becomes options', bold?.length === 2, show(bold));
check(
  'the bold run is the chip and the rest is the hint',
  bold?.[0].label === 'Restore at promotion' && bold?.[0].hint.startsWith('move restoreTerminals()'),
  show(bold?.[0])
);
check(
  "bd's 78-column wrap is folded back before anything is read",
  bold?.[0].response.includes('directory read on the critical path of a swap'),
  bold?.[0].response
);
check(
  'the chip is cut for the screen but the answer it sends is not',
  bold?.[0].response.length > bold?.[0].label.length + bold?.[0].hint.length,
  `${bold?.[0].response.length} vs ${bold?.[0].label.length} + ${bold?.[0].hint.length}`
);
check('(recommended) stars exactly one', starred(bold).join() === 'Restore at startup', show(starred(bold)));
check(
  'the response reads as an answer on its own, not as a chip label',
  bold?.[1].response.startsWith('Restore at startup — leave it where it is'),
  bold?.[1].response
);
check(
  'and the recommendation marker is not part of the answer that gets sent',
  !/recommended/i.test(bold?.[1].response ?? 'recommended'),
  bold?.[1].response
);

const LABELLED = `We have to pick one before the migration.

Option A — keep both columns and backfill nightly. Slow, reversible.

Option B: drop the old column now. Fast, and there is no way back.`;
const labelled = suggestOptions(LABELLED);
check(
  '"Option A —" and "Option B:" are read as options even outside a list',
  labels(labelled).join(' | ') === 'keep both columns and backfill nightly | drop the old column now',
  show(labelled)
);

const LEAD = `Where should the nightly dump land?

The options:

- Amazon S3, paid by the card already on file
- Backblaze B2, which is cheaper and one more account
- Google Drive on the personal account`;
const lead = suggestOptions(LEAD);
check(
  'a plain list under a lead-in line is read',
  labels(lead).join(' | ') ===
    'Amazon S3, paid by the card already on file | Backblaze B2, which is cheaper and one more account | Google Drive on the personal account',
  show(lead)
);
check(
  'and with nothing to split on, the whole item is both the chip and the answer',
  lead?.[0].response === 'Amazon S3, paid by the card already on file' && lead?.[0].hint === '',
  show(lead?.[0])
);

const REC_LINE = `Two ways forward:

- **Raise the cap** to 50 and move on.
- **Make it configurable** per workspace.

Recommendation: raise the cap. Configurable is a setting nobody will ever change.`;
const recLine = suggestOptions(REC_LINE);
check(
  'a standalone recommendation line stars the option it names',
  starred(recLine).join() === 'Raise the cap',
  show(recLine)
);

// The shape the `handoff` skill tells every session to write: the options in
// --design, one per line, closed with a bare RECOMMEND. This is the fixture that
// matters most — it is what most human beads in the tracker actually look like.
const HANDOFF = `- **Keep both columns** — backfill nightly and drop the old one next quarter.
  Slow, and reversible at any point.
- **Drop it now** — one migration, ten minutes of write downtime, no way back.

RECOMMEND Keep both columns — the downtime is cheap but the irreversibility is
not, and nothing downstream needs the column gone this month.`;
const handoff = suggestOptions(HANDOFF);
check(
  "the handoff skill's shape parses",
  labels(handoff).join(' | ') === 'Keep both columns | Drop it now',
  show(handoff)
);
check(
  'and its bare "RECOMMEND <label>" — no colon — stars the right one',
  starred(handoff).join() === 'Keep both columns',
  show(starred(handoff))
);

// The shape bc-j0zl asked its question in — three lettered ways to make room on the
// bottom bar — which got no buttons at all until this strategy existed. A bracketed
// letter is not the word "Option", and the bold each item is wrapped in made every
// label read `(a)`.
const LETTERS = `Foundations is a standing view reached by a glyph in the inbox's
header, with two controls in its own header that both go back to the inbox and no
bottom bar at all. The bar has five tabs and \`style.css:3345\` already shrinks the
labels to 9.5px if a sixth appears. Three ways:

- **(a)** Foundations takes Admin's place on the bar; Admin moves behind Foundations.
- **(b)** Foundations stays a header glyph but gets the bottom bar on its own page and
  loses the duplicate \`‹\`/\`✕\`. Cheapest, fixes the hallway, leaves the bar alone.
- **(c)** Six tabs, and accept the 9.5px labels the stylesheet is already prepared for.

I recommend **(b)** now, and letting (a) wait until Foundations has been usable long
enough for you to know how often you open it.`;
const letters = suggestOptions(LETTERS);
check('a lettered set — (a), (b), (c) — becomes options', letters?.length === 3, show(letters));
check(
  'and the letter stays on the chip, because it is the word the question itself used',
  labels(letters).every((l, i) => l.startsWith(`(${'abc'[i]}) `)),
  show(labels(letters))
);
check(
  'the letter is in the answer too, so the thread records the choice the way it was asked',
  letters?.[2].response.startsWith('(c) Six tabs'),
  letters?.[2].response
);
check(
  '"I recommend (b)" stars the option it names, which no label match could find',
  starred(letters).join().startsWith('(b)'),
  show(starred(letters))
);
check(
  'and the sentence after the letter does not leak into the answer',
  !/nobody knows yet|usable long enough/.test(letters?.[1].response ?? ''),
  letters?.[1].response
);

const PAREN_FREE = `Pick one:

a) Keep the daemon polling every 25 seconds.

b) Wake it on the bus and drop the timer.`;
check(
  'the opening bracket is optional — "a)" is as explicit as "(a)"',
  labels(suggestOptions(PAREN_FREE)).join(' | ') ===
    '(a) Keep the daemon polling every 25 seconds. | (b) Wake it on the bus and drop the timer.',
  show(suggestOptions(PAREN_FREE))
);

// Bracketed, because a bare `1)` at the start of a line is an ordered list item and
// markdown has already eaten the number by the time anything here sees it.
const NUMBERED_MARKERS = `Which retention?

- **(1)** Thirty days, and the bill stays where it is.
- **(2)** A year, which is four times the bill.`;
check(
  'and it counts as well as it letters',
  labels(suggestOptions(NUMBERED_MARKERS)).join(' | ') ===
    '(1) Thirty days, and the bill stays where it is. | (2) A year, which is four times the bill.',
  show(suggestOptions(NUMBERED_MARKERS))
);

/* ------------------------------------------------------------ the rejections */

console.log('\nshapes it must refuse');

const refuses = (name, md) => check(name, suggestOptions(md) === null, show(suggestOptions(md)));

refuses('nothing at all', '');
refuses('prose with no list', 'Adam has to make this call. It is an account decision, not a code one.');
refuses(
  'a single item — one option is not a choice',
  'What now?\n\n- **Ship it** and watch the logs.'
);
refuses(
  'seven items — that is a document, not a question',
  `The options:\n${['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `- **${x}** — do ${x}.`).join('\n')}`
);
refuses(
  'a checklist — those are work, not answers',
  'The options:\n\n- [ ] **Ship it** now\n- [x] **Wait** for the review'
);
refuses(
  'lettered items that do not start at the beginning — that is a fragment of somewhere else',
  'As I said above:\n\n- **(b)** Keep the glyph.\n- **(c)** Six tabs.'
);
refuses(
  'and lettered items that skip — a run with a hole in it was not written as a set',
  'Pick one:\n\n- **(a)** Keep the glyph.\n- **(c)** Six tabs.'
);
refuses(
  'a list inside a fenced block — a transcript is not a set of answers',
  'Here is what it printed:\n\n```\nThe options:\n- **one** thing\n- **two** thing\n```'
);
refuses(
  'two bold lists and nothing asked — it cannot tell which one is the question',
  `What changed:

- **The reaper** no longer runs on standby.
- **The router** holds the long poll across a swap.

Still to do:

- **Terminals** need a decision.
- **Sessions** are fine as they are.`
);

const TWO_LISTS_ONE_QUESTION = `What changed:

- **The reaper** no longer runs on standby.
- **The router** holds the long poll across a swap.

So: when should a standby restore terminals?

- **At promotion** — freshest, costs a read during the swap.
- **At startup** — simplest, and the list can go stale.`;
const disambiguated = suggestOptions(TWO_LISTS_ONE_QUESTION);
check(
  'but with a question between them it takes the list that answers it',
  labels(disambiguated).join(' | ') === 'At promotion | At startup',
  show(disambiguated)
);

refuses(
  'a list that is not the next thing after the lead-in — the paragraphs changed the subject',
  `The options:

Actually, hold on. We went round this last week and got nowhere, and nothing
about it has been written down since.

Here is what changed underneath it in the meantime:

- the reaper no longer runs on standby
- the router holds the long poll across a swap`
);

refuses(
  'two items that say the same thing — that is a parse gone wrong, not a choice',
  'The options:\n\n- **Wait** — hold off until Monday.\n- **Wait** — hold off until Tuesday.'
);

/* ------------------------------------------------------- the star, both ways */

console.log('\nthe recommendation, and its negation');

const NEGATED = `The options:

- **Rebuild from scratch** — clean, and three weeks. Not recommended.
- **Patch it in place** — ugly, and it ships Friday.`;
const negated = suggestOptions(NEGATED);
check('"not recommended" does not star the option it warns about', starred(negated).length === 0, show(negated));
check('and the list is still offered', labels(negated).length === 2, show(negated));

const TWO_STARS = `The options:

- **First** — do this. (recommended)
- **Second** — or this. (recommended)`;
check(
  'two recommendations star only the first — a card is the wrong place to find a contradiction',
  starred(suggestOptions(TWO_STARS)).join() === 'First',
  show(suggestOptions(TWO_STARS))
);

const REC_NAMES_NOTHING = `The options:

- **First** — do this.
- **Second** — or this.

Recommendation: neither, ask the vendor first.`;
check(
  'a recommendation line naming nothing in the list stars nothing',
  starred(suggestOptions(REC_NAMES_NOTHING)).length === 0,
  show(suggestOptions(REC_NAMES_NOTHING))
);

/* --------------------------------------------------------------- the budgets */

console.log('\nlength');

const LONG = `The options:

- **${'A very long option name that would wrap three times on a phone screen'.repeat(2)}** — and a hint.
- **Short** — the other one.`;
const long = suggestOptions(LONG);
check('a chip label is cut to something a phone can draw', long?.[0].label.length <= 73, String(long?.[0].label.length));
check('and says it was cut', long?.[0].label.endsWith('…'), long?.[0].label);

const ESSAY = `The options:

- **Do it** — ${'This sentence explains why at considerable length. '.repeat(30)}
- **Do not** — the other one.`;
const essay = suggestOptions(ESSAY);
check('a response is capped', essay?.[0].response.length <= 500, String(essay?.[0].response.length));
check(
  'and cut at a sentence, so it never ends mid-thought',
  /[.!?]$/.test(essay?.[0].response ?? ''),
  essay?.[0].response.slice(-60)
);

/* -------------------------------------------------- fields, and what wins where */

console.log('\nwhich field, and which parser');

const sections = [
  { field: 'description', markdown: 'No list here, just prose about the problem.' },
  { field: 'notes', markdown: 'The options:\n\n- **Yes** — go ahead.\n- **No** — leave it.' },
];
const fromSections = suggestFromSections(sections);
check(
  'it falls through to the field that actually carries the list, and says which',
  fromSections?.from === 'notes' && fromSections.options.length === 2,
  show(fromSections)
);

const bead = (over = {}) => ({ id: 'x-1', title: 'A question', status: 'open', ...over });

const prose = toQuestion('ws', bead({ description: BOLD }));
check('toQuestion attaches the suggestions', prose.suggested?.options.length === 2, show(prose.suggested));
check('and leaves decision null, as it was', prose.decision === null, show(prose.decision));

const withBlock = toQuestion(
  'ws',
  bead({
    description: `${BOLD}\n\n\`\`\`decision\nquestion: Which?\noptions:\n  - id: p\n    label: Promotion\n  - id: s\n    label: Startup\n\`\`\``,
  })
);
check(
  'a bead that already has real options gets no guesses beside them',
  withBlock.suggested === null && withBlock.decision.options.length === 2,
  show(withBlock.suggested)
);

const emptyBlock = toQuestion('ws', bead({ description: `${BOLD}\n\n\`\`\`decision\nquestion: Which?\n\`\`\`` }));
check(
  'but a block with a question and no options still gets them — that card had nothing to tap',
  emptyBlock.suggested?.options.length === 2,
  show(emptyBlock.suggested)
);

const proposal = toQuestion(
  'ws',
  bead({
    description: `${BOLD}\n\n\`\`\`beadproposal\nbeads:\n  - title: One\n    type: task\n    priority: 2\n\`\`\``,
  })
);
check(
  'a proposal draws its own per-bead controls, so it gets no chips to disagree with them',
  proposal.proposal !== null && proposal.suggested === null,
  show(proposal.suggested)
);

/* ------------------------------------------- the block's own recommended field */

console.log('\nrecommended, written rather than guessed');

const block = (yaml) => parseDecision(`\`\`\`decision\n${yaml}\n\`\`\``).decision;

const inline = block('question: Which?\noptions:\n  - id: a\n    label: A\n    recommended: true\n  - id: b\n    label: B');
check('recommended: true on an option is carried through', starred(inline?.options).join() === 'A', show(inline?.options));

const named = block('question: Which?\nrecommend: b\noptions:\n  - id: a\n    label: A\n    recommended: true\n  - id: b\n    label: B');
check(
  'a top-level recommend: names the winner and overrides an inline marker',
  starred(named?.options).join() === 'B',
  show(named?.options)
);

const byLabel = block('question: Which?\nrecommend: Second one\noptions:\n  - First one\n  - Second one');
check('recommend: matches a label as well as an id', starred(byLabel?.options).join() === 'Second one', show(byLabel?.options));

const bogus = block('question: Which?\nrecommend: nonexistent\noptions:\n  - A\n  - B');
check('and a recommend: naming nothing stars nothing', starred(bogus?.options).length === 0, show(bogus?.options));

const plainOpts = block('question: Which?\noptions:\n  - A\n  - B');
check(
  'every option carries the field, so the client never branches on undefined',
  plainOpts?.options.every((o) => o.recommended === false),
  show(plainOpts?.options)
);

/* ------------------------------------------------- what the client may do with them */

console.log('\nthe contract with the client');

const src = fs.readFileSync(LIB('suggest.js'), 'utf8');
check(
  'nothing in lib/suggest.js shells out or reaches the network — it is parsing, and stays parsing',
  !/child_process|execFile|spawn|fetch\(/.test(src),
  (src.match(/.*(child_process|execFile|spawn|fetch\().*/) || [])[0]
);

const app = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8');
const handler = app.slice(app.indexOf("if (act === 'suggest')"));
const body = handler.slice(0, handler.indexOf('\n    }\n') + 1);
check('the client has a handler for a suggested option at all', body.length > 100, String(body.length));
check(
  "and it fills the box rather than sending it — a machine-extracted sentence is never posted under Adam's name without him reading it",
  !/submit\(|api\(/.test(body),
  (body.match(/.*(submit\(|api\().*/) || [])[0]
);
check(
  'it writes the draft, so a suggestion survives the card being collapsed like anything else typed',
  /setDraft\(/.test(body),
  body
);

/* --------------------------------------- and the same rule for a written option */

// The buttons a real `decision` block draws are not this file's output, and since
// bc-5ldc they are governed by a *narrower* version of the same rule rather than the
// same one: on a shut card a choice answers on the second tap, and on an open card it
// fills the box and sends nothing. What has to hold here is the half that touches a
// suggestion's own guarantee — the box-filling path never posts — plus the arm in
// front of the half that does. scripts/option-check.mjs proves the whole gesture in a
// browser; these are here because they cost nothing and run without Chrome, which is
// what `npm test` has. test/optionanswer.mjs is where the shut half is pinned properly.
const optHandler = app.slice(app.indexOf("if (act === 'option')"));
const optBody = optHandler.slice(0, optHandler.indexOf('\n    }\n') + 1);
// The shut-card branch, and everything after it — which is the open card's path.
const shutAt = optBody.indexOf('if (!state.open.has(key) && !getDraft(key).trim()) {');
const openPath = shutAt === -1 ? optBody : optBody.slice(optBody.indexOf('[data-role="answer"]', shutAt));
check('the client still has a handler for a written option', optBody.length > 100, String(optBody.length));
check(
  'the shut card’s choice is the one that sends, and it is guarded by an arm',
  shutAt !== -1 && /state\.armed !== token[\s\S]*?return;[\s\S]*?submit\(/.test(optBody.slice(shutAt)),
  shutAt === -1 ? 'no shut-card branch at all' : 'the write is not behind the arm'
);
check(
  'and on an open card it fills the box rather than sending it — a choice is picked there and committed by the button under it',
  !/submit\(|api\(/.test(openPath),
  (openPath.match(/.*(submit\(|api\().*/) || [])[0]
);
check(
  'it remembers which choice was made, because the words can be edited and the id cannot',
  /state\.picked\.set\(/.test(optBody),
  optBody
);
check(
  'and the answer carries that id, which is the only thing that can say it commissions work',
  /option:\s*act === 'answer' \? pickedOption\(q\)\?\.id/.test(app),
  (app.match(/.*pickedOption\(q\)\?\.id.*/) || [])[0] || 'no option id on the answer path'
);

// The mirror is the same card on a screen with room for it, and it answers through
// the same endpoints. It has no browser harness of its own, so the one rule that
// must not drift between the two surfaces is pinned here by reading it: a click
// fills the composer, and `respond()` is reached only from the button under it.
const mirror = fs.readFileSync(path.join(HERE, '..', 'public', 'mirror.js'), 'utf8');
const mirrorHandler = mirror.slice(mirror.indexOf("if (act === 'option')"));
const mirrorBody = mirrorHandler.slice(0, mirrorHandler.indexOf('\n    }\n') + 1);
check('the mirror has a handler for a written option too', mirrorBody.length > 100, String(mirrorBody.length));
check(
  'and it fills the composer rather than answering — the same bead must not behave differently on the two screens',
  !/respond\(|api\(/.test(mirrorBody),
  (mirrorBody.match(/.*(respond\(|api\().*/) || [])[0]
);
check(
  'its answer carries the pick, so a commission is still a commission from the Mac',
  /respond\(t, text, act === 'respond', act === 'respond' \? state\.picks\.get\(key\)/.test(mirror),
  (mirror.match(/.*respond\(t, text.*/) || [])[0] || 'no pick on the mirror answer path'
);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all checks passed');
