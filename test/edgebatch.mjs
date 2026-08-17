#!/usr/bin/env node
/**
 * One refused edge must not abandon the rest of the batch.
 *
 *     npm test
 *     node test/edgebatch.mjs
 *
 * bc-arj0.19, and it is measured rather than imagined. Filing bc-khoe from a chat
 * proposal, `bd dep add bc-khoe.5 bc-45yl` was refused — the pair already carried an
 * edge of another type, which lib/mentions.js draws for free the moment either id
 * appears in the other's prose — and the create path stopped there. The proposal
 * declared five dependencies; the three after the failing one were never attempted.
 *
 * Nothing looked wrong: nine beads, the right parents, the right text. The structure
 * that was missing was on the beads furthest from where the error was reported, and the
 * error named neither of them. That is bc-arj0's own failure mode — a dependency
 * declared, and then existing only as prose in a description — arriving by a new route,
 * which is why the fix is a suite and not a one-line try.
 *
 * **The failing edge here is deliberately not the last one.** A batch whose bad edge is
 * last passes on the broken code too: everything before it landed, and there was nothing
 * after it to lose. The refusal in the HTTP half is the second of four, so the two edges
 * behind it are the assertion.
 *
 * Nothing spawns an agent or an editor: a console with no seed sends no turn, so `bd` is
 * the only subprocess and it is a fake.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-edgebatch-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { applyEdges, edgeCommand, refusalReason, retryCommand } = await import(LIB('edges.js'));
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

/* --------------------------------------------------------------- the module */

console.log('lib/edges.js — every declared edge is attempted');

/** A `bd` stand-in: refuses whichever pairs are named, records every call in order. */
const fakeBd = (refuse = new Set()) => {
  const calls = [];
  return {
    calls,
    async addDep(ws, from, to) {
      calls.push(`${from}→${to}`);
      if (refuse.has(`${from}→${to}`)) {
        throw new Error(`bd dep add ${from} ${to} failed in ${ws.name}: dependency already exists between these issues`);
      }
      return '';
    },
  };
};

const WSNAME = { name: 'beadcause' };
const rows = (...pairs) => pairs.map(([from, dep]) => ({ from, dep }));

await check('a refusal in the middle costs that edge and nothing after it', async () => {
  const bd = fakeBd(new Set(['b→x']));
  const out = await applyEdges(bd, WSNAME, rows(['a', 'w'], ['b', 'x'], ['c', 'y'], ['d', 'z']), {
    resolve: async (dep) => dep,
  });
  assert.deepEqual(bd.calls, ['a→w', 'b→x', 'c→y', 'd→z'], 'every declared edge must be attempted');
  assert.deepEqual(
    out.applied.map((e) => `${e.from}→${e.to}`),
    ['a→w', 'c→y', 'd→z']
  );
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].why, 'refused');
});

await check('the failure names both ends, as the command that would fix it', async () => {
  const bd = fakeBd(new Set(['bc-khoe.5→bc-45yl']));
  const out = await applyEdges(bd, WSNAME, rows(['bc-khoe.5', 'bc-45yl']), { resolve: async (d) => d });
  const line = out.warnings.find((w) => w.startsWith('bd dep add bc-khoe.5 bc-45yl'));
  assert.ok(line, `no pasteable line in: ${out.warnings.join(' | ')}`);
  assert.match(line, /refused: dependency already exists between these issues/);
  // And not wearing lib/bd.js's own prefix twice — the command is already the start of
  // the line, so repeating it is half a phone's width gone before the reason begins.
  assert.doesNotMatch(line, /failed in beadcause/);
});

await check('the batch is summarised with one paste that retries every refusal', async () => {
  const bd = fakeBd(new Set(['b→x', 'd→z']));
  const out = await applyEdges(bd, WSNAME, rows(['a', 'w'], ['b', 'x'], ['c', 'y'], ['d', 'z']), {
    resolve: async (d) => d,
  });
  const summary = out.warnings[out.warnings.length - 1];
  assert.match(summary, /2 of 4 declared dependencies did not land; the other 2 did\./);
  assert.match(summary, /Paste to retry: bd dep add b x; bd dep add d z/);
  assert.equal(retryCommand(out.failed), 'bd dep add b x; bd dep add d z');
});

await check('a clean batch says nothing at all', async () => {
  const bd = fakeBd();
  const out = await applyEdges(bd, WSNAME, rows(['a', 'w'], ['b', 'x']), { resolve: async (d) => d });
  assert.deepEqual(out.warnings, [], 'a summary on a clean run is noise on the screen that produced it');
  assert.equal(out.failed.length, 0);
  assert.equal(out.applied.length, 2);
});

await check('an unresolvable end is a warning, and stays out of the retry command', async () => {
  const bd = fakeBd(new Set(['b→x']));
  const out = await applyEdges(bd, WSNAME, rows(['a', 'nope'], ['b', 'x'], ['c', 'y']), {
    resolve: async (d) => (d === 'nope' ? null : d),
  });
  assert.deepEqual(bd.calls, ['b→x', 'c→y'], 'an unresolved end is never handed to bd');
  assert.ok(out.warnings.some((w) => w === 'a: dependency on nope skipped — no such bead'));
  // Two failures, one retryable: there is no id to paste for the one that resolved to
  // nothing, so offering `bd dep add a nope` would be offering a command that cannot work.
  assert.equal(out.failed.length, 2);
  assert.equal(retryCommand(out.failed), 'bd dep add b x');
});

await check('a bead that depends on itself is said so, not called missing', async () => {
  const bd = fakeBd();
  const out = await applyEdges(bd, WSNAME, rows(['a', 'a']), { resolve: async (d) => d });
  assert.deepEqual(bd.calls, []);
  assert.match(out.warnings[0], /a bead cannot depend on itself/);
});

await check('a `resolve` that throws is an unresolved end, not a lost batch', async () => {
  const bd = fakeBd();
  const out = await applyEdges(bd, WSNAME, rows(['a', 'boom'], ['b', 'x']), {
    resolve: async (d) => {
      if (d === 'boom') throw new Error('the tracker is down');
      return d;
    },
  });
  assert.deepEqual(bd.calls, ['b→x']);
  assert.equal(out.applied.length, 1);
});

await check('the near end going missing is named by the ref the proposal used', async () => {
  const bd = fakeBd();
  const out = await applyEdges(bd, WSNAME, [{ from: null, dep: 'x', ref: 'retry-client' }], {
    resolve: async (d) => d,
  });
  assert.match(out.warnings[0], /^retry-client: dependency on x skipped/);
});

await check('refusalReason and edgeCommand are the one spelling both callers use', () => {
  assert.equal(edgeCommand('bc-a', 'bc-b'), 'bd dep add bc-a bc-b');
  assert.equal(refusalReason(new Error('bd dep add a b failed in ws: no.\nstack')), 'no.');
  assert.equal(refusalReason(new Error('plain trouble')), 'plain trouble');
  assert.equal(refusalReason(null), 'bd refused it and said nothing');
});

/* ------------------------------------------------- through the console create */

console.log('\nPOST /api/console/create — the path bc-arj0.19 was found on');

const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');
const STATE = path.join(tmp, 'bd-state.json');

/**
 * A `bd` that creates, shows and refuses on demand.
 *
 * `.cjs` deliberately: it is spawned by absolute path out of a temp directory, and the
 * extension is the only thing that settles how node parses it. `refuse` in the state
 * file is a list of `<from> <to>` pairs `dep add` exits 1 on, worded as bd words it.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(STATE)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(STATE)}, JSON.stringify(state));
if (args[0] === 'list') { console.log(JSON.stringify(state.issues || [])); process.exit(0); }
if (args[0] === 'create') {
  const title = args[args.indexOf('--title') + 1];
  if ((state.createFails || []).includes(title)) { process.stderr.write('bd said no\\n'); process.exit(1); }
  const id = 'bc-new' + ((state.created = (state.created || 0) + 1));
  state.issues.push({ id, title, status: 'open', labels: [], description: '' });
  save();
  console.log(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'show') {
  const hit = (state.issues || []).find((i) => i.id === args[1]);
  console.log(JSON.stringify(hit ? [hit] : []));
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const pair = args[2] + ' ' + args[3];
  if ((state.refuse || []).includes(pair)) {
    process.stderr.write('dependency already exists between these issues\\n');
    process.exit(1);
  }
  (state.edges = state.edges || []).push(pair);
  save();
  process.exit(0);
}
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
  workspaces: [WS],
  spaces: [],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
};
fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });

const setState = (extra = {}) =>
  fs.writeFileSync(STATE, JSON.stringify({ issues: [], created: 0, edges: [], refuse: [], ...extra }));
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const calls = () =>
  fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const resetCalls = () => fs.writeFileSync(CALLS, '');

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

/** A chat session with nothing seeded, so opening it spawns nothing. */
const openChat = async () => (await post('/api/console', { workspace: WS.name })).body.id;

const card = (ref, title, extra = {}) => ({
  ref,
  title,
  type: 'task',
  priority: 2,
  description: 'Because it is worth doing.',
  ...extra,
});

/**
 * The bc-khoe shape, in miniature: four beads and four edges between them, created in
 * ref order so `bc-new1`…`bc-new4` line up with `one`…`four`.
 */
// The titles carry the check's own tag because lib/bd.js caches live titles for a
// minute: reusing them would have every card after the first check flagged as a
// duplicate of the one the check before it made, which is true and beside the point.
const proposal = (tag) => [
  card('one', `The first ${tag}`),
  card('two', `The second ${tag}`, { dependsOn: ['one'] }),
  card('three', `The third ${tag}`, { dependsOn: ['one'] }),
  card('four', `The fourth ${tag}`, { dependsOn: ['two', 'three'] }),
];

await check('the whole batch lands when nothing refuses', async () => {
  setState();
  resetCalls();
  const id = await openChat();
  const { status, body } = await post('/api/console/create', { id, draft: { beads: proposal('clean') } });
  assert.equal(status, 200);
  assert.equal(body.created.length, 4);
  assert.deepEqual(readState().edges, [
    'bc-new2 bc-new1',
    'bc-new3 bc-new1',
    'bc-new4 bc-new2',
    'bc-new4 bc-new3',
  ]);
  assert.deepEqual(body.warnings, []);
  assert.equal(body.closed, true, 'a clean run ends the conversation');
});

await check('a refusal that is not the last edge still lets the rest land', async () => {
  // `bc-new3 bc-new1` is the second of four. Two edges come after it, and on the code
  // this suite was written against neither was ever attempted.
  setState({ refuse: ['bc-new3 bc-new1'] });
  resetCalls();
  const id = await openChat();
  const { status, body } = await post('/api/console/create', { id, draft: { beads: proposal('middle') } });
  assert.equal(status, 200, 'a refused edge is not a failed create');
  assert.equal(body.created.length, 4, 'every bead is still made');
  const attempted = calls().filter((c) => c[0] === 'dep' && c[1] === 'add').map((c) => `${c[2]} ${c[3]}`);
  assert.deepEqual(attempted, ['bc-new2 bc-new1', 'bc-new3 bc-new1', 'bc-new4 bc-new2', 'bc-new4 bc-new3']);
  assert.deepEqual(readState().edges, ['bc-new2 bc-new1', 'bc-new4 bc-new2', 'bc-new4 bc-new3']);
});

await check('and the report names the edge that did not, by id, pasteably', async () => {
  setState({ refuse: ['bc-new3 bc-new1'] });
  const id = await openChat();
  const { body } = await post('/api/console/create', { id, draft: { beads: proposal('report') } });
  const line = body.warnings.find((w) => w.startsWith('bd dep add bc-new3 bc-new1'));
  assert.ok(line, `warnings were: ${body.warnings.join(' | ')}`);
  assert.match(line, /dependency already exists between these issues/);
  assert.match(
    body.warnings[body.warnings.length - 1],
    /1 of 4 declared dependencies did not land; the other 3 did\. Paste to retry: bd dep add bc-new3 bc-new1/
  );
  assert.equal(body.closed, false, 'warnings have to be read on the screen that produced them');
});

await check('a create that fails part-way still wires what it did make', async () => {
  // The same argument one step out: the beads that exist are real, and the structure
  // between them is no less true for a later card having failed to become a bead.
  setState({ createFails: ['The fourth partial'] });
  resetCalls();
  const id = await openChat();
  const { status, body } = await post('/api/console/create', { id, draft: { beads: proposal('partial') } });
  assert.equal(status, 502, 'a create that fails is still a failure');
  assert.equal(body.created.length, 3);
  assert.deepEqual(readState().edges, ['bc-new2 bc-new1', 'bc-new3 bc-new1']);
  assert.ok(body.warnings.some((w) => /stopped after an error/.test(w)));
});

/* --------------------------------------------------------------------- done */

for (const s of servers) s.close();
cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
