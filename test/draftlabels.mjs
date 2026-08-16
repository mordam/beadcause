#!/usr/bin/env node
/**
 * A label survives a chat proposal exactly as it was written — colon, `@` and all.
 *
 *     npm test
 *     node test/draftlabels.mjs
 *
 * Every bead filed from the chat proposal of 2026-08-13 came out carrying **two** owner
 * labels: `owner:neadamthal@gmail.com`, which is the real one, and
 * `owner-neadamthal-gmail-com`, which is a lookalike no query matches. Twelve for twelve,
 * and by the time bc-vriu.1 was picked up it was twenty-three, because every child
 * created under one of those epics inherits its parent's labels.
 *
 * The mechanism is two lines long and worth stating, because the second half is what
 * made it a *pair* rather than a rename:
 *
 * 1. `lib/draft.js` slugged every label on the way in — the same `slug()` it uses for a
 *    `ref`, a `parent` and a `dependsOn`, which are identifiers this file invents and
 *    which genuinely want lowercasing and dashes. A label is not one of those. It is a
 *    value the tracker owns, and the ones that matter are structured:
 *    `owner:<handle>` (lib/ownership.js), `held:<stamp>:<handle>` (lib/lease.js),
 *    `superseded-by:<id>` (lib/superseded.js). All three are read back by splitting on
 *    the colon, so slugging does not tidy them — it destroys them.
 * 2. `Bd.create` then stamps this machine's owner onto any P0 that arrives without one
 *    (`ownOwnerLabels`, lib/bd.js). `ownersOf` looks for the `owner:` prefix, the slug
 *    no longer had it, so the bead looked unowned and got a second label naming the same
 *    person. The epic ended up with both, and `bd create --parent` handed the pair down.
 *
 * So this covers the whole path rather than the regex: the YAML block an agent writes,
 * the JSON a phone posts back after editing, and `POST /api/console/create` all the way
 * to the argv `bd` is actually spawned with. The last one is the assertion that would
 * have caught this — the two earlier layers were both innocent-looking on their own.
 *
 * **And it pins what must keep being slugged.** The fix is not "stop calling slug"; refs
 * and the edges pointing at them still need it, or two spellings of one intention become
 * two beads. A test that only asserted labels survive would be passed by deleting the
 * function.
 *
 * The console's own copy of this normalisation (`public/console.js` splits the Labels
 * field on the comma, and used to slug each piece) is checked as a static read at the
 * end. A vm could drive it, but the sheet has to be rendered and a chat loaded to get at
 * the handler, and what is worth pinning there is one expression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const PUBLIC = (name) => path.join(HERE, '..', 'public', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-draftlabels-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { extractProposal, normalizeDraft, draftToYaml } = await import(LIB('draft.js'));
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

/** The handle off the real incident, because the shape of it is the whole test. */
const ME = 'neadamthal@gmail.com';
const OWNER = `owner:${ME}`;
/** What twelve beads were filed carrying instead. Nothing must ever produce this again. */
const TWIN = 'owner-neadamthal-gmail-com';

const block = (...lines) => ['```beads', 'beads:', ...lines, '```'].join('\n');

/* ----------------------------------------------------- what the agent writes */

console.log('the YAML block an agent writes');

await check('an owner label comes out of a beads block exactly as it went in', () => {
  const { draft, error } = extractProposal(block('  - title: An epic', '    priority: 0', `    labels: ["${OWNER}"]`));
  assert.equal(error, null, String(error));
  assert.deepEqual(draft.beads[0].labels, [OWNER]);
});

await check('and so do the other two structured labels this tracker reads back', () => {
  // Both are split on the colon by the code that consumes them (lib/lease.js,
  // lib/superseded.js), so a slugged one is not a tidier label — it is a dead one.
  const held = 'held:20260814T033808Z:neadamthal@gmail.com';
  const sup = 'superseded-by:bc-vriu.1';
  const { draft } = extractProposal(block('  - title: A bead', `    labels: ["${held}", "${sup}", "Needs Review"]`));
  // Case is left alone too: bd stores a label verbatim, and lowercasing `Needs Review`
  // would be this file deciding something about a value it does not own.
  assert.deepEqual(draft.beads[0].labels, [held, sup, 'Needs Review']);
});

await check('a comma splits, because the editor field is one comma-separated input', () => {
  // `bd create --label 'a,b'` splits on the comma itself, so a label containing one
  // cannot reach the tracker whatever this does. Splitting here means the card shows
  // what will actually be filed.
  const { draft } = extractProposal(block('  - title: A bead', '    labels: "api, tracker ,, "'));
  assert.deepEqual(draft.beads[0].labels, ['api', 'tracker']);
});

await check('refs, parents and edges are still slugged — that half was never the bug', () => {
  const { draft } = extractProposal(
    block(
      '  - ref: The Epic',
      '    title: An epic',
      '  - ref: Some Groundwork',
      '    title: The groundwork',
      '  - ref: child',
      '    title: A child',
      '    parent: The Epic',
      '    dependsOn: ["Some Groundwork"]'
    )
  );
  assert.equal(draft.beads[0].ref, 'the-epic', 'a ref is an identifier this file invents');
  assert.equal(draft.beads[2].parent, 'the-epic', 'and the edge has to land on the same string');
  // Pointed at a sibling rather than at its own parent: `validateDraft` retires that
  // edge, because bd refuses an explicit dependency the hierarchy already carries.
  assert.deepEqual(draft.beads[2].dependsOn, ['some-groundwork']);
});

/* -------------------------------------------------- what the phone posts back */

console.log('\nwhat the phone posts back');

await check('a draft edited on the phone keeps its labels through normalizeDraft', () => {
  const draft = normalizeDraft({
    beads: [{ ref: 'epic', title: 'An epic', priority: 0, labels: [OWNER, 'tracker'] }],
  });
  assert.deepEqual(draft.beads[0].labels, [OWNER, 'tracker']);
});

await check('and through the YAML the next turn argues with', () => {
  // `draftToYaml` is fed back to the agent so it argues with what is on your screen. A
  // label that survived the editor and died in the round trip would come back slugged in
  // the agent's next proposal, which is the same bug one turn later.
  const draft = normalizeDraft({ beads: [{ ref: 'epic', title: 'An epic', labels: [OWNER] }] });
  const back = extractProposal(['```beads', draftToYaml(draft), '```'].join('\n'));
  assert.deepEqual(back.draft.beads[0].labels, [OWNER]);
});

/* ------------------------------------------------------------ the filing path */

console.log('\nand the argv bd is spawned with');

const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');

/**
 * A `bd` that creates whatever it is asked to and records every argv.
 *
 * `.cjs` deliberately: it is spawned by absolute path out of a temp directory, and the
 * extension is the only thing that settles how node parses it.
 */
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
  // Without this `ownOwnerLabels` returns nothing and the P0 stamp — the half that made
  // the twin a *pair* rather than a rename — never runs at all.
  me: ME,
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
    ? fs
        .readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');
/** Every `--label` on the one `bd create` this made, in the order it was passed. */
const labelsPassed = () => {
  const create = calls().find((c) => c[0] === 'create');
  assert.ok(create, `bd create was never reached: ${JSON.stringify(calls())}`);
  return create.filter((_a, i) => create[i - 1] === '--label');
};

const openChat = async () => (await post('/api/console', { workspace: WS.name })).body.id;
const fileOne = async (bead) => {
  const id = await openChat();
  resetCalls();
  const { status, body } = await post('/api/console/create', {
    id,
    draft: { beads: [{ ref: 'epic', title: 'An epic', type: 'epic', description: 'Because.', ...bead }] },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
};

await check('a P0 card naming its owner is filed with that owner and nothing else', async () => {
  // The incident, end to end. Before the fix this argv carried both `owner-...` (the
  // slug lib/draft.js made) and `owner:...` (the stamp Bd.create added because it could
  // not see an owner through the slug).
  await fileOne({ priority: 0, labels: [OWNER, 'tracker'] });
  const labels = labelsPassed();
  assert.deepEqual(labels, [OWNER, 'tracker'], `two labels for one fact: ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes(TWIN), 'the slugified twin is the whole of bc-vriu.1');
});

await check('a P0 card naming nobody still gets this machine’s owner, exactly once', async () => {
  // The stamp is a feature and must keep working — an unowned P0 is the state
  // lib/ownership.js exists to clear. What changed is that it now sees an owner when
  // there is one.
  await fileOne({ priority: 0, labels: ['tracker'] });
  assert.deepEqual(labelsPassed(), ['tracker', OWNER]);
});

await check('an ordinary card keeps the owner it names and is given no other', async () => {
  await fileOne({ priority: 2, labels: ['owner:someone@else.example', 'api'] });
  assert.deepEqual(labelsPassed(), ['owner:someone@else.example', 'api']);
});

/* ------------------------------------------------------------ what the phone runs */

console.log('\nand the copy of this the phone runs');

const consoleJs = fs.readFileSync(PUBLIC('console.js'), 'utf8');

await check('the Labels field splits on the comma and slugs nothing', () => {
  const handler = consoleJs.match(/field === 'labels'\s*\?([\s\S]*?):\s*el\.value;/);
  assert.ok(handler, 'the labels branch of the field handler has moved');
  assert.match(handler[1], /split\(','\)/, 'it is still a comma-separated field');
  assert.doesNotMatch(
    handler[1],
    /\[\^a-z0-9\]|toLowerCase/,
    'the phone must send what was typed — a slug here refiles the same bead with the same two labels'
  );
});

/* ------------------------------------------------------------------------ end */

for (const s of servers) s.close();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
