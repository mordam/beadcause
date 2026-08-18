#!/usr/bin/env node
/**
 * A bead filed through the console declares the files it expects to touch — all the way.
 *
 *     npm test
 *     node test/consolesurface.mjs
 *
 * bc-42ow.1 gave the surface a reader: a fenced `beadfiles` block in a bead's own
 * description, and `declaredFiles` in lib/beadfiles.js as the only thing that reads it.
 * On the day it landed, nothing in this repo wrote one — every bead in every tracker
 * answered `[]`, and the reader was correct and useless. bc-42ow.2 is the writer.
 *
 * **The failure this is shaped against is silent.** A surface has to cross five stages —
 * the YAML an agent emits, the draft the server holds, the card a phone renders and
 * edits, the YAML fed back to the agent next turn, and the `bd create` at the end — and
 * a stage that drops it looks *exactly* like a stage that kept it. The card says
 * `2 files`, the person taps Create, the bead is filed with nothing, and the advocate
 * reports `[]` forever with nobody able to say which of the five ate it. So the
 * assertions here are round trips through the real path rather than five unit tests of
 * five functions: the last one drives `POST /api/console/create` against a `bd` that
 * records its argv, and reads the surface back out of the `--description` that bd was
 * actually spawned with.
 *
 * Both write paths, because there are two and they share only their format:
 *
 * 1. **The chat console** — lib/draft.js parses the `beads` block, public/console.js
 *    renders and edits the card, lib/server.js files it. Its bead shape has `ref`s.
 * 2. **An advocate's proposal** — lib/proposal.js parses the `beadproposal` block and
 *    renders the question body, lib/filing.js turns a bead into `bd create` arguments.
 *    `bin/file.js` and `bin/propose.js` are this path too.
 *
 * **And what must stay legal is asserted as hard as what is new.** A bead with no
 * surface is not an error, is not a warning, and is filed with its description
 * byte-identical to what it would have carried before any of this existed — that is
 * every bead `bd create` has ever made by hand. bc-42ow's P0 is explicit that a wrong
 * surface must dispatch rather than withhold, and a field that could refuse a filing
 * would move the cost to the one place it says it must never be.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const PUBLIC = (name) => path.join(HERE, '..', 'public', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-consolesurface-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { declaredFiles, parseSurface } = await import(LIB('beadfiles.js'));
const { extractProposal, normalizeDraft, draftToYaml } = await import(LIB('draft.js'));
const { parseProposal, proposalBody, applyEdits } = await import(LIB('proposal.js'));
const { beadToIssue } = await import(LIB('filing.js'));
const { createApp, listen } = await import(LIB('server.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

const beadsBlock = (...lines) => ['```beads', 'beads:', ...lines, '```'].join('\n');

/* --------------------------------------------------- 1. the block an agent writes */

console.log('the `beads` block a chat session writes');

await check('a card carries the files it named', () => {
  const { draft, error } = extractProposal(
    beadsBlock('  - title: Give the client a retry policy', '    files: [lib/dms.js, lib/retry.js]')
  );
  assert.equal(error, null, String(error));
  assert.deepEqual(draft.beads[0].files, ['lib/dms.js', 'lib/retry.js']);
});

await check('under any of the four names an agent might reach for', () => {
  // The text is generated, so an unrecognised key is not a typo somebody notices — it is
  // a surface that silently is not there, which is the exact failure this bead is about.
  for (const key of ['files', 'touches', 'paths', 'surface']) {
    const { draft } = extractProposal(beadsBlock('  - title: A bead', `    ${key}: [lib/a.js]`));
    assert.deepEqual(draft.beads[0].files, ['lib/a.js'], `\`${key}:\` was not read`);
  }
});

await check('spelled the one way lib/beadfiles.js spells it, whatever was typed', () => {
  // Two beads that spell one file differently read as disjoint, and that is the single
  // failure the whole field exists to prevent — so normalisation happens here, at the
  // card, not at filing time, and the person editing sees the path that will be written.
  const { draft } = extractProposal(
    beadsBlock('  - title: A bead', '    files: ["./lib/a.js", "/lib/b.js", "test/", "lib/a.js"]')
  );
  assert.deepEqual(draft.beads[0].files, ['lib/a.js', 'lib/b.js', 'test/**']);
});

await check('a card that named nothing has an empty surface, not a missing one', () => {
  const { draft } = extractProposal(beadsBlock('  - title: A bead with no opinion about files'));
  assert.deepEqual(draft.beads[0].files, []);
});

await check('and neither a junk surface nor a huge one is ever an error', () => {
  // A declaration is a forecast written before anybody read the code. A field that could
  // withhold work by being malformed would be worse than no field at all — bc-42ow.
  const { draft, error } = extractProposal(
    beadsBlock('  - title: A bead', '    files: [not-a-path, "..", "", 7]')
  );
  assert.equal(error, null, String(error));
  assert.equal(draft.beads.length, 1, 'the bead survives its own bad surface');
  // A number is not a path and yields nothing — dropped, not stringified into one.
  assert.deepEqual(draft.beads[0].files, ['not-a-path']);
  assert.deepEqual(draft.warnings, [], 'nothing warns about a surface');
});

/* ------------------------------------------- 2. the round trip through the phone */

console.log('\nthe round trip: agent → card → phone → agent');

await check('a surface survives an edit on the phone', () => {
  // `normalizeDraft` is what the phone's JSON goes through, and it re-normalises rather
  // than trusting the client — so the editor cannot widen the schema, and cannot narrow
  // it either.
  const draft = normalizeDraft({
    beads: [{ ref: 'a', title: 'A bead', files: ['lib/a.js', './lib/a.js', 'public/b.js'] }],
  });
  assert.deepEqual(draft.beads[0].files, ['lib/a.js', 'public/b.js']);
});

await check('and comes back out of the YAML the agent is shown next turn', () => {
  // `draftToYaml` is fed to the agent at the start of the next turn so it argues with
  // what is on your screen. A surface you corrected that the agent never sees is one it
  // will confidently propose again — the same argument that put labels in this block.
  const draft = normalizeDraft({ beads: [{ ref: 'a', title: 'A bead', files: ['lib/a.js', 'test/a.mjs'] }] });
  const back = extractProposal(['```beads', draftToYaml(draft), '```'].join('\n'));
  assert.equal(back.error, null, String(back.error));
  assert.deepEqual(back.draft.beads[0].files, ['lib/a.js', 'test/a.mjs']);
});

await check('a card with no surface adds no `files` key to that YAML', () => {
  const draft = normalizeDraft({ beads: [{ ref: 'a', title: 'A bead' }] });
  assert.doesNotMatch(draftToYaml(draft), /files/, 'an empty list must not read as a declaration');
});

/* ---------------------------------------------- 3. the advocate's proposal path */

console.log('\nand the same field through an advocate’s proposal');

const proposalOf = (bead) =>
  parseProposal(
    ['```beadproposal', YAML.stringify({ workspace: 'beadcause', beads: [bead] }), '```'].join('\n')
  );

await check('a proposed bead carries its surface', () => {
  const proposal = proposalOf({ title: 'A bead', description: 'Because.', files: ['lib/a.js'] });
  assert.deepEqual(proposal.beads[0].files, ['lib/a.js']);
});

await check('the question body says so where a person will read it', () => {
  const proposal = proposalOf({ title: 'A bead', description: 'Because.', files: ['lib/a.js', 'test/a.mjs'] });
  const body = proposalBody('beadcause', proposal.beads);
  assert.match(body, /\*\*Expects to touch:\*\* lib\/a\.js, test\/a\.mjs/);
});

await check('and the block under it re-parses to the same surface', () => {
  // The prose above the fold and the machine-readable block below are rendered from one
  // parsed object, so the body a person reads and the thing the server files from cannot
  // disagree — which only holds if the field survives being written back out.
  const proposal = proposalOf({ title: 'A bead', description: 'Because.', files: ['lib/a.js'] });
  const round = parseProposal(proposalBody('beadcause', proposal.beads));
  assert.deepEqual(round.beads[0].files, ['lib/a.js']);
});

await check('an adjusted bead keeps a surface it did not adjust', () => {
  const proposal = proposalOf({ title: 'A bead', description: 'Because.', files: ['lib/a.js'] });
  const edited = applyEdits(proposal.beads, { 1: { priority: 0 } });
  assert.equal(edited[0].priority, 0);
  assert.deepEqual(edited[0].files, ['lib/a.js']);
});

/* --------------------------------------- 4. what `bd create` is actually handed */

console.log('\nwhat the filing path hands bd');

await check('the surface is written into the description as the block the reader reads', () => {
  const issue = beadToIssue({ title: 'A bead', description: 'Why it exists.', files: ['lib/a.js', 'test/a.mjs'] });
  assert.match(issue.body, /Why it exists\./, 'the prose survives');
  assert.deepEqual(declaredFiles({ description: issue.body }), ['lib/a.js', 'test/a.mjs']);
});

await check('and not into notes, which no advocate tick ever reads', () => {
  // `bd list --json` carries `description` on every row and carries neither `notes` nor
  // `design`. A surface in notes would cost one `bd show` per ready bead per tick.
  const issue = beadToIssue({ title: 'A bead', description: 'Why.', files: ['lib/a.js'] });
  assert.deepEqual(parseSurface(issue.notes), [], 'the surface must not be in notes');
  assert.deepEqual(parseSurface(issue.design), []);
});

await check('a bead that declared nothing is filed byte-for-byte as it always was', () => {
  // The whole of "it stays legal to file a bead with no surface". `withSurface`'s empty
  // case *withdraws* a block, and withdrawal is not something any caller here can mean —
  // so a description with a block somebody typed by hand survives a card with no opinion.
  const prose = 'Why it exists.\n\nWith a second paragraph.  ';
  assert.equal(beadToIssue({ title: 'A bead', description: prose }).body, prose);
  const handWritten = ['Prose.', '', '```beadfiles', 'lib/a.js', '```'].join('\n');
  assert.equal(beadToIssue({ title: 'A bead', description: handWritten }).body, handWritten);
  assert.deepEqual(declaredFiles({ description: beadToIssue({ title: 'A bead', description: handWritten }).body }), [
    'lib/a.js',
  ]);
});

await check('and a re-filed bead ends up with one block rather than two', () => {
  // `parseSurface` reads the *first* block, so a corrected surface appended after the one
  // it corrects would silently lose to it. `withSurface` replaces; this pins that the
  // filing path gets that behaviour rather than its own.
  const first = beadToIssue({ title: 'A bead', description: 'Prose.', files: ['lib/a.js'] }).body;
  const second = beadToIssue({ title: 'A bead', description: first, files: ['lib/b.js'] }).body;
  assert.deepEqual(declaredFiles({ description: second }), ['lib/b.js']);
  assert.equal(second.match(/```beadfiles/g).length, 1);
});

/* ----------------------------------- 5. end to end, through the real create call */

console.log('\nand the argv bd is actually spawned with');

const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');

/** A `bd` that creates whatever it is asked to and records every argv. See test/draftlabels.mjs. */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
if (args[0] === 'create') { console.log(JSON.stringify({ id: 'bc-new' + args.indexOf('--title') })); process.exit(0); }
console.log('[]');
`,
  { mode: 0o755 }
);

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: BD,
  actor: 'beadcause-test',
  me: 'nobody@example.com',
  workspaces: [WS],
  spaces: [],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};
fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const calls = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');

/** The `--description` of the one `bd create` this made — what the bead will really carry. */
const descriptionPassed = () => {
  const create = calls().find((c) => c[0] === 'create');
  assert.ok(create, `bd create was never reached: ${JSON.stringify(calls())}`);
  const at = create.indexOf('--description');
  return at === -1 ? null : create[at + 1];
};

/** One card, straight through `POST /api/console/create`, exactly as the button does it. */
const createOne = async (bead) => {
  const id = (await post('/api/console', { workspace: WS.name })).body.id;
  resetCalls();
  const { status, body } = await post('/api/console/create', {
    id,
    draft: { beads: [{ ref: 'a', title: 'A bead', type: 'task', description: 'Why it exists.', ...bead }] },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
};

await check('a card naming files files a bead whose description the reader can read', async () => {
  // The assertion the other four layers cannot make on their own: this is the text bd
  // was handed, and `declaredFiles` is the advocate's own function reading it back.
  const res = await createOne({ files: ['lib/a.js', 'test/a.mjs'] });
  assert.equal(res.created?.length, 1, JSON.stringify(res));
  const description = descriptionPassed();
  assert.match(description, /Why it exists\./, 'the prose survives the trip');
  assert.deepEqual(declaredFiles({ description }), ['lib/a.js', 'test/a.mjs']);
});

await check('a surface typed carelessly on the phone still arrives spelled one way', async () => {
  // The phone sends what was typed; lib/beadfiles.js is the only thing that decides what
  // a path is, so `./lib/a.js` from a card and `lib/a.js` from a plan are one file.
  await createOne({ files: ['./lib/a.js', 'lib/', 'lib/a.js'] });
  assert.deepEqual(declaredFiles({ description: descriptionPassed() }), ['lib/a.js', 'lib/**']);
});

await check('a card that named no files files exactly the description it showed', async () => {
  await createOne({});
  assert.equal(descriptionPassed(), 'Why it exists.');
  assert.deepEqual(declaredFiles({ description: descriptionPassed() }), []);
});

await check('and nothing about a surface can refuse a filing', async () => {
  const res = await createOne({ files: ['not a path at all', '..', 7, null] });
  assert.equal(res.created?.length, 1, `a bad forecast must never withhold work: ${JSON.stringify(res)}`);
  assert.deepEqual(
    (res.warnings || []).filter((w) => /file|surface|touch/i.test(w)),
    [],
    'and must not even warn'
  );
});

/* -------------------------------------------------- 6. the copy the phone runs */

console.log('\nand the card the phone draws');

const consoleJs = fs.readFileSync(PUBLIC('console.js'), 'utf8');
const monitorJs = fs.readFileSync(PUBLIC('monitor.js'), 'utf8');
const appJs = fs.readFileSync(PUBLIC('app.js'), 'utf8');

await check('the draft card has a files field, and it is editable', () => {
  assert.match(consoleJs, /data-field="files"/, 'the card must show the seam to the person correcting it');
});

await check('and the phone splits it without inventing a second opinion on what a path is', () => {
  const handler = consoleJs.match(/field === 'files'\s*\?([\s\S]*?):\s*el\.value;/);
  assert.ok(handler, "the files branch of the field handler has moved");
  assert.match(handler[1], /split\(/, 'it is a separated field');
  assert.doesNotMatch(
    handler[1],
    /replace\(|toLowerCase/,
    'normalising here is how two spellings of one file come to read as two files'
  );
});

await check('an advocate’s proposal card names the files too', () => {
  // Both of them: the inbox row is the card Adam actually taps, the advocate's own
  // dashboard row is where a proposal is read before it gets there.
  assert.match(appJs, /Expects to touch/, 'the inbox row is where a wrong forecast gets corrected');
  assert.match(monitorJs, /Expects to touch/);
});

await check('and no file but lib/beadfiles.js writes the block itself', () => {
  // The same guard test/beadfiles.mjs runs over lib and bin, extended to the two files
  // that draw a card. A second spelling of the fence is how two screens come to disagree
  // about one thing — and here it would be a block the reader cannot read.
  const fence = ['`', '`', '`', 'beadfiles'].join('');
  const code = (src) =>
    src
      .split('\n')
      .filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l))
      .join('\n');
  assert.ok(!code(consoleJs).includes(fence), 'public/console.js must call the helpers, not spell the fence');
  assert.ok(!code(monitorJs).includes(fence), 'public/monitor.js must call the helpers, not spell the fence');
  assert.ok(!code(appJs).includes(fence), 'public/app.js must call the helpers, not spell the fence');
});

/* ------------------------------------------------------------------------ end */

for (const s of servers) s.close();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
