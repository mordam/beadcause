#!/usr/bin/env node
//
// The foundation changes an amendment is not allowed to ask for.
//
//   npm test                     (runs it alongside the other suites)
//   node test/beyond.mjs         (on its own)
//
// `AMENDABLE` is eight fields, and an agent can reach conclusions about itself that are
// none of them: a PROTECTED field, the brief it was handed this run, or something in a
// module that is not its foundation at all. Until bc-w22d all three ended the same way —
// `parseAmendment` rejected the block on the first non-amendable field and the caller
// logged "ignoring a malformed amendment request" and dropped it. The prohibition was
// right; destroying the reasoning was not. An advocate that has run the same survey
// forty times saying "the instructions I am given are wrong about X" is the single most
// valuable thing it can tell you, and it was the one thing it could not say.
//
// What is asserted here, in the order it happens:
//
// 1. **The parse still refuses, and no longer forgets.** A block naming a non-amendable
//    field comes back with `error` set — so nothing can half-apply it, which is the
//    property the whole loop rests on — *and* with the fields named in `beyond` plus the
//    scope, the argument and the evidence intact.
// 2. **The bars come first.** A request with no scope, or with a justification that is a
//    phrase, dies at the parse whichever channel it was heading for. Being unanswerable
//    is not improved by being filed somewhere new.
// 3. **The bead it becomes.** Built through `proposal.normalizeBead`, so it is
//    indistinguishable in shape from one a model wrote, and it survives the round trip
//    through the card body and back out of `parseProposal` — because the block in that
//    body is what `createProposed` actually files from.
// 4. **A real survey, end to end.** The advocate is ticked against a fake `claude` that
//    asks for `writes: true` and proposes nothing else, and what reaches the tracker is
//    one proposal card carrying its argument. Adam still creates it or does not; the
//    agent has gained a channel and no write.
// 5. **The amendable half is untouched.** A second advocate, in the same tick, asks for
//    an allowlist entry and still gets the amendment card it always got.
//
// Nothing here touches a tracker, a network or a real Claude: `bd` is an object of async
// stubs, `claude` is a script in a temp dir that answers from a file in its cwd, and the
// config directory is redirected before anything under lib/ is imported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beyond-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// a test that wrote advocate state into the real ~/.config/beadcause would be editing a
// running daemon's mind.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// Observer mode resolves at load too, and it makes `propose` return before it spawns
// anything — a suite run inside an observer shell would pass the survey case by never
// running it. See the same note in test/allowlist.mjs.
delete process.env.BEADCAUSE_OBSERVE;
delete process.env.BEADCAUSE_READONLY;

// foundation.js first, deliberately: it and agents.js import each other, and the module
// entered first is the one whose constants initialise.
const foundation = await import(LIB('foundation.js'));
const amendment = await import(LIB('amendment.js'));
const { parseProposal, proposalBody } = await import(LIB('proposal.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ---------------------------------------------------------------- the harness */

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

/** An amendment block, with whatever `set:` the case is about. */
const block = (
  setYaml,
  {
    scope = 'the narrowest version — only beads you have already approved',
    just = 'Every survey ends with a proposal you approve one at a time, and the three you took last week were mine verbatim. Saying yes here would save you the taps and cost you the review step.',
  } = {}
) => `Nothing worth proposing this time.

\`\`\`amendment
agent: advocate
kind: prohibited
scope: ${scope}
justification: |
  ${just}
evidence: |
  $ bd create --title="Cache-bust site.js" --type=task
  permission denied: Bash(bd create:*) is not in your allowlist
${setYaml}
\`\`\`
`;

/* ------------------------------------------------------------------ the parse */

console.log('\nwhat the parse keeps\n');

await test('a protected field is refused, and named rather than forgotten', () => {
  const r = amendment.parseAmendment(block('set:\n  writes: true'));
  assert.ok(r.error, 'no error: something could apply this');
  assert.match(r.error, /not amendable: writes/);
  assert.deepEqual(r.beyond, ['writes']);
  // The whole reason for the change: the argument survives the rejection.
  assert.match(r.justification, /save you the taps/);
  assert.match(r.scope, /narrowest version/);
  assert.match(r.evidence, /permission denied/);
  assert.equal(r.agent, 'advocate');
});

await test('so is a field that is nothing in the foundation at all', () => {
  const r = amendment.parseAmendment(block('set:\n  surveyPrompt: look at the tests first'));
  assert.deepEqual(r.beyond, ['surveyPrompt']);
  assert.ok(r.error);
});

await test('every offending field is named, not just the first one', () => {
  const r = amendment.parseAmendment(block('set:\n  writes: true\n  protocolOwner: lib/mine.js'));
  assert.deepEqual(r.beyond, ['writes', 'protocolOwner']);
});

await test('an amendable request is unchanged — no beyond, no error', () => {
  const r = amendment.parseAmendment(block('add:\n  allowedTools:\n    - Bash(rg:*)'));
  assert.equal(r.error, null);
  assert.equal(r.beyond, undefined);
  assert.deepEqual(r.add.allowedTools, ['Bash(rg:*)']);
});

await test('the bars still come first: no scope, no request, whichever channel', () => {
  const r = amendment.parseAmendment(block('set:\n  writes: true', { scope: '' }));
  assert.match(r.error, /no scope/);
  // Nothing to file: `beyond` absent is what stops lib/advocate.js proposing a bead
  // nobody could answer.
  assert.equal(r.beyond, undefined);
});

await test('and a justification that is a phrase dies the same way', () => {
  const r = amendment.parseAmendment(block('set:\n  writes: true', { just: 'it would be quicker' }));
  assert.match(r.error, /justification/);
  assert.equal(r.beyond, undefined);
});

await test('a block with no amendment in it is still nothing at all', () => {
  assert.equal(amendment.parseAmendment('I found two things and proposed them.'), null);
});

/* -------------------------------------------------------- where a commit goes */

console.log('\nthe file a commit would have to touch\n');

await test('a protected field is written in lib/foundation.js and says so', () => {
  assert.equal(foundation.commitOwner('writes'), 'lib/foundation.js');
  assert.equal(foundation.commitOwner('protocolOwner'), 'lib/foundation.js');
});

await test('anything else resolves to the module that composes that agent’s brief', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  // The advocate is the case that makes this field worth having: lib/proposal.js parses
  // its output, and lib/advocate.js writes the brief it is arguing with.
  assert.equal(f.briefOwner, 'lib/advocate.js');
  assert.equal(f.protocolOwner, 'lib/proposal.js');
  assert.equal(foundation.commitOwner('surveyPrompt', f), 'lib/advocate.js');
});

await test('every agent has one, or the bead it lands on cannot name a file', async () => {
  for (const agent of foundation.AGENTS) {
    const f = await foundation.effective(ROOT, agent);
    assert.ok(f.briefOwner, `${agent} has no briefOwner`);
    assert.ok(fs.existsSync(path.join(ROOT, f.briefOwner)), `${agent}: ${f.briefOwner} does not exist`);
  }
});

await test('and it is not amendable — a signpost, not a permission', () => {
  assert.ok(!foundation.AMENDABLE.includes('briefOwner'));
  const r = amendment.parseAmendment(block('set:\n  briefOwner: lib/mine.js'));
  assert.deepEqual(r.beyond, ['briefOwner']);
});

/* ------------------------------------------------------------------- the bead */

console.log('\nthe bead it becomes\n');

const beadFor = async (setYaml, opts) => {
  const r = amendment.parseAmendment(block(setYaml, opts));
  const f = await foundation.effective(ROOT, 'advocate');
  return amendment.beyondAmendment(r, f, { workspace: 'demo', from: 'the demo survey' });
};

await test('it carries the agent’s own words, and the file, and what it would cost', async () => {
  const b = await beadFor('set:\n  writes: true');
  assert.match(b.description, /save you the taps/);
  assert.match(b.description, /lib\/foundation\.js/);
  assert.match(b.description, /permission denied/);
  // The advocate for another repo files into that repo's tracker, and the file it is
  // arguing about is not in that checkout. A bead that does not say so sends whoever
  // picks it up looking for lib/foundation.js in the wrong repo.
  assert.match(b.description, /beadcause/);
  assert.ok(b.acceptance, 'no acceptance criteria: nobody can tell when this is done');
});

await test('a protected field is a decision; the brief is a task', async () => {
  assert.equal((await beadFor('set:\n  writes: true')).type, 'decision');
  assert.equal((await beadFor('set:\n  surveyPrompt: read the tests first')).type, 'task');
  // Below the work an advocate finds in the repo. An agent's opinion about itself is
  // worth hearing and is not worth outranking a bug someone can point at.
  assert.equal((await beadFor('set:\n  writes: true')).priority, 3);
});

await test('it is a proposal-shaped bead, not a second kind of object', async () => {
  const b = await beadFor('set:\n  writes: true');
  for (const k of ['title', 'type', 'priority', 'description', 'acceptance', 'rationale', 'labels', 'deps']) {
    assert.ok(k in b, `missing ${k} — proposalBody would render undefined`);
  }
  assert.ok(b.title.length <= 200, 'the title was not clamped');
  // No `human`, and nothing that would collide with the labels beadcause files by: an
  // AMENDMENT_LABEL here would make every future amendment "held back, one is open".
  assert.deepEqual(b.labels, []);
});

await test('nothing in it can close the fence that carries it', async () => {
  // Not through a block: a fence inside the justification would end the `amendment`
  // block it was written in, long before this. The case that matters is the one where a
  // model got a fence past the parse some other way — an `evidence` line read off a
  // transcript, or a justification arriving from `applyEdits` — because the description
  // built here goes on to live inside the ` ```beadproposal ` fence in `proposalBody`,
  // and a stray ``` there truncates the card and the block the server files from.
  const r = amendment.parseAmendment(block('set:\n  writes: true'));
  r.justification = 'The command I could not run is ```bd create --title=x``` and it is the fence that matters here, because this bead is carried inside one.';
  r.evidence = 'A second one, ```like this```.';
  const b = amendment.beyondAmendment(r, await foundation.effective(ROOT, 'advocate'), { workspace: 'demo' });
  assert.ok(!b.description.includes('```'), 'a fence in the justification survived into the description');
  assert.match(b.description, /bd create --title=x/, 'the words were dropped along with the backticks');
  const back = parseProposal(proposalBody('demo', [b]));
  assert.equal(back.beads.length, 1, 'the card truncated at the inner fence');
  assert.match(back.beads[0].description, /bd create --title=x/);
});

await test('and it survives the card body and comes back out of the parser', async () => {
  const b = await beadFor('set:\n  writes: true');
  const body = proposalBody('demo', [b]);
  const back = parseProposal(body);
  assert.equal(back.error, null);
  assert.equal(back.beads.length, 1, 'the block in the body is what createProposed files from');
  assert.equal(back.beads[0].type, 'decision');
  assert.equal(back.beads[0].priority, 3);
  assert.equal(back.beads[0].title, b.title);
  // Byte for byte, not merely recognisable. The description is markdown with lists and a
  // block quote in it, and `proposalBody` stringifies without forcing a literal scalar —
  // a folded one would join those lines and the card would arrive as one paragraph.
  assert.equal(back.beads[0].description, b.description, 'the YAML round trip reflowed the markdown');
  assert.equal(back.beads[0].acceptance, b.acceptance);
});

await test('a request that is not one of these is not a bead at all', async () => {
  const f = await foundation.effective(ROOT, 'advocate');
  const amendable = amendment.parseAmendment(block('add:\n  allowedTools:\n    - Bash(rg:*)'));
  // Belt and braces for the one thing worse than the log line this replaced: a card
  // naming no field, which Adam still has to read and cannot answer.
  assert.equal(amendment.beyondAmendment(amendable, f, {}), null);
  assert.equal(amendment.beyondAmendment(null, f, {}), null);
});

/* ------------------------------------------------------- and a survey runs it */

console.log('\na survey run, against a fake claude\n');

/**
 * Two repos, two advocates, one tick — and the fake `claude` answers from a file in the
 * directory it was spawned in, so each gets its own answer without a second harness.
 */
const FAKEBIN = path.join(tmp, 'bin');
fs.mkdirSync(FAKEBIN, { recursive: true });
fs.writeFileSync(
  path.join(FAKEBIN, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// The prompt matters as much as the answer here: the reflection section is what tells the
// agent where a non-amendable change belongs, and it is only in the argv.
fs.writeFileSync(path.join(process.cwd(), 'PROMPT.md'), process.argv[3] || '');
const answer = fs.readFileSync(path.join(process.cwd(), 'ANSWER.md'), 'utf8');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: answer }) + '\\n');
`,
  { mode: 0o755 }
);
// `agentEnv` builds the child's env from `process.env`, so this is how the fake wins:
// ~/.zprofile only ever *appends* to PATH, and the real claude lives at the end of it.
process.env.PATH = `${FAKEBIN}:${process.env.PATH}`;

/** A real git repo: `effective` and the reflection step both read refs out of one. */
function repo(name, answer) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'ANSWER.md'), answer);
  return dir;
}

const beyondRepo = repo('beyond', block('set:\n  writes: true'));
const amendableRepo = repo(
  'amendable',
  `One thing stood out.

\`\`\`beadproposal
workspace: amendable
beads:
  - title: Cache-bust site.js on deploy
    type: task
    priority: 2
    description: |
      The script tag carries no ?v=, so a shipped change looks absent.
    acceptance: A deploy changes the URL the browser asks for.
    rationale: Found in bin/router.js while surveying.
\`\`\`

\`\`\`amendment
agent: advocate
kind: prohibited
scope: rg under this checkout only, read-only, no other command
justification: |
  Grep times out on this repo's node_modules and I fell back to reading files one at a
  time, which is why this survey found one thing and not three. rg would have been a
  single call.
add:
  allowedTools:
    - Bash(rg:*)
\`\`\`
`
);

const created = [];
const bd = {
  // Empty: an advocate only proposes when there is nothing left to work, which is the
  // one state that reaches `surveyAgent` at all.
  ready: async () => [],
  listLabel: async () => [],
  show: async () => null,
  create: async (workspace, spec) => {
    created.push({ workspace: workspace.name, spec });
    return `${workspace.name}-1`;
  },
};

const cfg = {
  workspaces: [
    { name: 'beyond', dir: path.join(beyondRepo, '.beads') },
    { name: 'amendable', dir: path.join(amendableRepo, '.beads') },
  ],
  sessionDirs: { beyond: beyondRepo, amendable: amendableRepo },
  spaces: [],
  claudeSessions: false,
  advocates: {
    enabled: true,
    workspaces: '*',
    propose: true,
    proposeCooldownHours: 1,
    proposeTimeoutMs: 60000,
    maxProposals: 5,
    // The sweep reaches into a real checkout's worktrees and has nothing to do with
    // this; quiet hours would skip the tick outright depending on the clock.
    tidyWorktrees: false,
    respectQuietHours: false,
    settleSeconds: 0,
    launchCooldownSeconds: 0,
  },
};

const events = [];
const advocates = createAdvocates(cfg, { bd, bus: { emit: (e) => events.push(e) } });
await advocates.tick();

const forWorkspace = (name) => created.filter((c) => c.workspace === name);

await test('the request only a commit can grant reached the tracker as a proposal', () => {
  const cards = forWorkspace('beyond');
  assert.equal(cards.length, 1, `bd.create ran ${cards.length} times for the beyond repo`);
  const [card] = cards;
  assert.ok(card.spec.labels.includes('human'), 'a proposal is Adam’s to approve');
  assert.ok(card.spec.labels.includes('advocate-proposal'), `labels: ${card.spec.labels.join(' ')}`);
  assert.match(card.spec.body, /save you the taps/, 'the argument did not survive');
  assert.match(card.spec.body, /lib\/foundation\.js/, 'the card does not say where a commit would go');
  const back = parseProposal(card.spec.body);
  assert.equal(back.error, null);
  assert.equal(back.beads.length, 1);
  assert.equal(back.beads[0].type, 'decision');
});

await test('and it did not become an amendment, because it cannot be applied', () => {
  for (const card of forWorkspace('beyond')) {
    assert.ok(
      !(card.spec.labels || []).includes(amendment.AMENDMENT_LABEL),
      'a foundation card was filed for a field no approval could set',
    );
  }
  // The other half of the same property: the survey proposed nothing, so the only bead
  // on that card is the agent's own request. Silence would have been the old behaviour.
  const [card] = forWorkspace('beyond');
  assert.doesNotMatch(card.spec.body, /```amendment/, 'the card carries a block dispatch would read as an open argument');
});

await test('the amendable half still files the amendment card it always did', () => {
  const cards = forWorkspace('amendable');
  const amend = cards.filter((c) => (c.spec.labels || []).includes(amendment.AMENDMENT_LABEL));
  const proposal = cards.filter((c) => (c.spec.labels || []).includes('advocate-proposal'));
  assert.equal(amend.length, 1, `${amend.length} amendment cards for an allowlist request`);
  assert.match(amend[0].spec.body, /Bash\(rg:\*\)/);
  assert.equal(proposal.length, 1, 'the survey’s own proposal went missing');
  assert.match(proposal[0].spec.body, /Cache-bust site\.js/);
  // One bead on that card: what it found. The self-request went down the other channel.
  assert.equal(parseProposal(proposal[0].spec.body).beads.length, 1);
});

await test('neither advocate reported an error', () => {
  for (const a of advocates.snapshot()) assert.equal(a.error, null, `${a.workspace}: ${a.error}`);
});

await test('the prompt told it where a non-amendable change belongs', () => {
  const prompt = fs.readFileSync(path.join(beyondRepo, 'PROMPT.md'), 'utf8');
  assert.match(prompt, /Only these are amendable/, 'the reflection step never reached the agent');
  // The three cases from bc-w22d, each named in the prompt rather than left to be
  // inferred from a rejection the agent never sees.
  assert.match(prompt, /beadproposal/, 'it was not pointed at the channel it does have');
  assert.match(prompt, /lib\/advocate\.js/, 'it was not told where its own brief is written');
  assert.match(prompt, /protocolOwner/);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nbeyond the amendable set: all good');
process.exit(failures ? 1 : 0);
