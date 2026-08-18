#!/usr/bin/env node
/**
 * ＋ on All Beads opens a form, and filing it makes the bead — bc-khoe.27.3.
 *
 *     npm test
 *     node test/beadform.mjs
 *
 * ＋ always means *new*, and what new is belongs to the view (bc-khoe.27.1). Chats keeps
 * the chat; `All Beads` — the screen listing every live bead in the tracker — files one.
 * Three things have to be true of that and none of them is visible by reading one
 * function.
 *
 * 1. **It is not a second write path to the tracker.** `createBead` in lib/server.js is
 *    one `bd create` behind two doors, the console's accept button and this form, so the
 *    two cannot come to disagree about which labels survive, where the declared surface
 *    goes, or whether `created_by` is stamped. The check with teeth is the *argv bd was
 *    actually spawned with*, read back out of a `bd` that records it — the same harness
 *    test/consolesurface.mjs and test/draftlabels.mjs drive, and for the same reason: a
 *    stage that drops a field looks exactly like a stage that kept it.
 *
 * 2. **It must not file orphans, and blank must not mean parentless.** Per this
 *    tracker's own discipline a bead with nothing decided above it is not workable
 *    (bc-rfnr.7) *and* descends from no root the inbox draws, so a create that quietly
 *    made them would be a button for filing beads nobody will ever see. Blank asks
 *    lib/homing.js, exactly as every agent-filed bead does; a *named* parent that does
 *    not exist is a refusal rather than a fallback, because a blank field is "you
 *    decide" and a typo is not.
 *
 * 3. **A bead you typed is not a bead an agent filed.** The obvious reuse here is
 *    `fileBeads` in lib/filing.js — it homes, it clamps, it is the filing seam — and it
 *    is the wrong one: it stamps `unendorsed`, `agent-filed`, a `discovered-from` edge
 *    and a note that opens "Filed by an agent". A bead you filed from your own phone
 *    arriving held for your own endorsement reads as a bug in the tracker. Asserted by
 *    name, on the argv, because it is the sort of thing a later refactor "tidies" into
 *    place.
 *
 * The client half is the last section. public/app.js is one IIFE with nothing exported,
 * so the declarations are sliced out and run in a `vm` the way test/composekind.mjs and
 * test/cardtap.mjs do it. Which kinds have a ＋ and what each one creates is
 * public/inboxfilter.js's, and test/inboxkinds.mjs checks it there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadform-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen } = await import(path.join(ROOT, 'lib', 'server.js'));

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${String(err.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

/* ------------------------------------------------------------------ the daemon */

/**
 * Three workspaces, because lib/bd.js caches one `bd export` per workspace for a minute
 * and the three cases this suite needs are three different graphs. Separate trackers is
 * the honest way to get three answers out of a cache that is doing its job.
 */
const WS = (name) => {
  const ws = { name, dir: path.join(tmp, name, '.beads') };
  fs.mkdirSync(ws.dir, { recursive: true });
  return ws;
};
const PILE = WS('haspile'); // an open epic labelled `unsorted`
const ROOTED = WS('rooted'); // an open epic with no such label
const BARE = WS('bare'); // no roots at all
const CALLS = path.join(tmp, 'bd-calls.log');

/** Rows a fake `bd export` hands back, per workspace. See `indexFrom` in lib/ancestry.js. */
const GRAPHS = {
  [PILE.name]: [
    { id: 'bc-pile', title: 'Unsorted backlog', status: 'open', issue_type: 'epic', labels: ['unsorted'] },
    { id: 'bc-real', title: 'A bead that exists', status: 'open', issue_type: 'task', labels: [] },
  ],
  [ROOTED.name]: [{ id: 'bc-root', title: 'An epic', status: 'open', issue_type: 'epic', labels: [] }],
  [BARE.name]: [],
};

/**
 * A `bd` that records every argv, answers `export` per workspace, and creates whatever
 * it is asked to — except a title carrying `EXPLODE`, which is how the refusal path is
 * driven without breaking anything else.
 *
 * The workspace reaches it as `BEADS_DIR`, which is how lib/bd.js points bd at one.
 */
const BD = path.join(tmp, 'bd.cjs');
fs.writeFileSync(
  BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const dir = process.env.BEADS_DIR || '';
const ws = path.basename(path.dirname(dir));
const GRAPHS = ${JSON.stringify(GRAPHS)};
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ ws, args }) + '\\n');
if (args[0] === 'export') {
  console.log((GRAPHS[ws] || []).map((r) => JSON.stringify(r)).join('\\n'));
  process.exit(0);
}
if (args[0] === 'show') {
  const hit = (GRAPHS[ws] || []).find((r) => r.id === args[1]);
  console.log(JSON.stringify(hit ? [hit] : []));
  process.exit(0);
}
if (args[0] === 'create') {
  const at = args.indexOf('--title');
  if (at !== -1 && String(args[at + 1]).includes('EXPLODE')) {
    console.error('bd: refusing this one\\nand a second line nobody should see');
    process.exit(1);
  }
  console.log(JSON.stringify({ id: 'bc-made' }));
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
  me: 'nobody@example.com',
  workspaces: [PILE, ROOTED, BARE],
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

/** The one `bd create` this made, as the flags bd was really spawned with. */
const createArgv = () => {
  const hit = calls().find((c) => c.args[0] === 'create');
  assert.ok(hit, `bd create was never reached: ${JSON.stringify(calls())}`);
  return hit.args;
};
/** One flag's value off that argv, or null when it was not passed at all. */
const flag = (name, argv = createArgv()) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
/** Every `--label` on it, which bd takes one at a time. */
const labels = (argv = createArgv()) =>
  argv.reduce((all, a, i) => (a === '--label' ? [...all, argv[i + 1]] : all), []);

const file = async (body) => {
  resetCalls();
  return post('/api/bead/create', { workspace: PILE.name, title: 'A bead', ...body });
};

console.log('\nfiling one bead through the form');

await check('a filled form files a bead with the fields as typed', async () => {
  const { status, body } = await file({
    title: 'Give the picker a keyboard',
    type: 'feature',
    priority: 1,
    description: 'Why it exists.',
    acceptance: 'How we would know.',
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.id, 'bc-made');
  assert.equal(body.key, `${PILE.name}/bc-made`);
  const argv = createArgv();
  assert.equal(flag('--title', argv), 'Give the picker a keyboard');
  assert.equal(flag('--type', argv), 'feature');
  assert.equal(flag('--priority', argv), '1');
  assert.equal(flag('--description', argv), 'Why it exists.');
  assert.equal(flag('--acceptance', argv), 'How we would know.');
});

await check('a bead you typed is not a bead an agent filed', async () => {
  // The reuse this bead invites is `fileBeads`, which stamps every one of these. A form
  // on your own phone that filed beads held for your own endorsement would be a create
  // that does not create anything until you go and tap it again.
  await file({ title: 'A bead of my own' });
  const on = labels();
  assert.ok(!on.includes('unendorsed'), `a hand-filed bead arrived held: ${JSON.stringify(on)}`);
  assert.ok(!on.includes('agent-filed'), `a hand-filed bead claims an agent filed it: ${JSON.stringify(on)}`);
  assert.ok(!on.includes('human'), `a hand-filed bead landed in the inbox as a question: ${JSON.stringify(on)}`);
  assert.equal(flag('--notes'), null, 'a provenance note about an agent was written onto it');
});

await check('a blank parent is the unsorted root, not an orphan', async () => {
  const { status, body } = await file({ title: 'Nobody said where this goes' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.parent, 'bc-pile');
  assert.equal(flag('--parent'), 'bc-pile', 'the bead was filed under nothing');
  assert.deepEqual(body.warnings, [], `a homed bead warned about anything: ${JSON.stringify(body.warnings)}`);
});

await check('a parent you named is used exactly as named', async () => {
  const { status, body } = await file({ title: 'Under a bead I chose', parent: 'bc-real' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.parent, 'bc-real');
  assert.equal(flag('--parent'), 'bc-real');
});

await check('a parent that does not exist is refused, and nothing is filed', async () => {
  // A blank field means "you decide"; a typo does not, and filing it into the backlog
  // instead would be the form silently doing something other than what was asked.
  const { status, body } = await file({ title: 'Under a typo', parent: 'bc-nope' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(body.error, /bc-nope/);
  assert.ok(!calls().some((c) => c.args[0] === 'create'), 'a refused parent still filed a bead');
});

await check('no title is refused, and nothing is filed', async () => {
  const { status, body } = await post('/api/bead/create', { workspace: PILE.name, title: '   ' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.ok(!calls().some((c) => c.args[0] === 'create'));
});

await check('an unknown workspace is refused rather than guessed at', async () => {
  const { status } = await post('/api/bead/create', { workspace: 'nowhere', title: 'A bead' });
  assert.equal(status, 400);
});

await check('a bd that refuses the write says so, in bd\'s own words', async () => {
  // "a refused write says so rather than failing silently" is the bead's own acceptance,
  // and the sentence has to be bd's: `502` is not something you can act on.
  const { status, body } = await file({ title: 'EXPLODE on this one' });
  assert.equal(status, 502, JSON.stringify(body));
  assert.match(body.error, /refusing this one/);
  assert.ok(!/second line/.test(body.error), 'the whole stderr was handed to the phone');
});

await check('a workspace with no root files parentless and does not cry hold', async () => {
  // `hasRootAbove` fails open where there are no roots at all, so the bead is perfectly
  // workable — and a warning saying nothing will work it would be a false claim printed
  // at every filing on a fresh tracker.
  resetCalls();
  const { status, body } = await post('/api/bead/create', { workspace: BARE.name, title: 'The first bead here' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.parent, '');
  assert.deepEqual(body.warnings, [], JSON.stringify(body.warnings));
});

await check('a workspace with roots but no pile says so rather than filing quietly', async () => {
  resetCalls();
  const { status, body } = await post('/api/bead/create', { workspace: ROOTED.name, title: 'Nowhere to put this' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.parent, '');
  assert.equal(body.warnings.length, 1, JSON.stringify(body.warnings));
  assert.match(body.warnings[0], /nothing to hang this under/);
  assert.match(body.warnings[0], /unsorted/, 'the warning does not say how to fix it');
});

await check('a daemon-owned label is dropped with a warning, not refused', async () => {
  // The same guard the console runs, because it is the same hazard: lib/proposedlabels.js
  // owns the list and the create must not fail over a label.
  const { status, body } = await file({ title: 'A bead with opinions', labels: 'ui, unendorsed' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(labels().includes('ui'), `an ordinary label was eaten: ${JSON.stringify(labels())}`);
  assert.ok(!labels().includes('unendorsed'));
  assert.ok(body.warnings.some((w) => /unendorsed/.test(w)), JSON.stringify(body.warnings));
});

/* ------------------------------------------------------- the form on the phone */

console.log('\nthe form the button opens');

const HTML = read('public/index.html');
const APP = read('public/app.js');

await check('index.html carries the form, and every field the route reads', () => {
  assert.match(HTML, /id="beadform"[^>]*class="sheet beadform"/, 'the sheet is gone or is not a .sheet');
  for (const id of ['title', 'description', 'acceptance', 'parent', 'labels', 'type', 'priority', 'ws']) {
    assert.ok(HTML.includes(`id="beadform-${id}"`), `the form has no ${id} field`);
  }
  // The two ways out and the one way in, by id, because app.js wires all three by id.
  for (const id of ['beadform-form', 'beadform-file', 'beadform-cancel', 'beadform-close', 'beadform-say']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is gone`);
  }
});

await check('＋ asks the filter what this view creates, rather than knowing the kinds', () => {
  // The one thing public/inboxfilter.js's header asks of this file: a second place that
  // knows what the six kinds are is a second place that can be wrong about them. So the
  // branch is on `creates()` and there is no list of kind ids in app.js to disagree with.
  assert.match(APP, /inboxFilter\?\.creates\?\.\(\) === 'bead'/, 'the ＋ branch no longer asks creates()');
  assert.ok(
    !/=== 'bead' \|\| .*=== 'epics'/.test(APP),
    'app.js has grown a list of kind ids beside the filter'
  );
});

/**
 * Lift one declaration out of public/app.js — the two shapes test/composekind.mjs lifts,
 * copied rather than shared for the reason it gives: a helper module between two suites
 * that read one file by hand is a third thing to keep true.
 */
function lift(opener) {
  const at = APP.indexOf(opener);
  assert.notEqual(at, -1, `public/app.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = APP.indexOf('{', at); i < APP.length; i += 1) {
      if (APP[i] === '{') depth += 1;
      else if (APP[i] === '}') {
        depth -= 1;
        if (!depth) return APP.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < APP.length; i += 1) {
    const c = APP[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return APP.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

/** A node with the two things `paintBeadForm` touches, plus a class list that behaves. */
const node = () => {
  const on = new Set();
  return {
    innerHTML: '',
    disabled: false,
    classList: {
      toggle(c, force) {
        if (force) on.add(c);
        else on.delete(c);
        return Boolean(force);
      },
      contains: (c) => on.has(c),
    },
  };
};

/** The form's own painting, over a space that allows `repos`. */
function room(repos) {
  const els = {};
  for (const sel of ['#beadform-ws', '#beadform-ws-field', '#beadform-type', '#beadform-priority', '#beadform-file']) {
    els[sel] = node();
  }
  const ctx = vm.createContext({
    window: { beadcause: { space: { inside: () => repos } } },
    state: { workspaces: repos },
    esc: (s) => String(s),
    $: (sel) => els[sel] || null,
  });
  vm.runInContext(
    [
      lift('const startableRepos = () => {'),
      lift("const BEAD_TYPES = ["),
      lift('const BEAD_PRIORITIES = ['),
      lift('const priorityWord = '),
      lift('const beadForm = {'),
      lift('const beadChip = '),
      lift('function paintBeadForm()'),
      'globalThis.paint = paintBeadForm;',
      'globalThis.form = beadForm;',
    ].join('\n'),
    ctx
  );
  return { els, form: ctx.form, paint: () => ctx.paint() };
}

await check('the workspace row is the same answer ＋ gives a chat', () => {
  const r = room(['alpha', 'beta']);
  r.paint();
  assert.match(r.els['#beadform-ws'].innerHTML, /data-value="alpha"/);
  assert.match(r.els['#beadform-ws'].innerHTML, /data-value="beta"/);
  assert.equal(r.form.workspace, 'alpha', 'nothing was preselected, so the button would refuse');
  assert.equal(r.els['#beadform-file'].disabled, false);
});

await check('one repo is stated rather than asked about', () => {
  const r = room(['only']);
  r.paint();
  assert.equal(r.form.workspace, 'only');
  assert.ok(r.els['#beadform-ws-field'].classList.contains('one'), 'the single-repo case is drawn as a choice');
});

await check('no repo at all says so, and the button refuses', () => {
  // A blank space where the choice should be reads as a control that failed to load.
  const r = room([]);
  r.paint();
  assert.match(r.els['#beadform-ws'].innerHTML, /No workspaces/);
  assert.equal(r.els['#beadform-file'].disabled, true, 'a form with nowhere to file could still be pressed');
});

await check('the chips are bd\'s own five types and five priorities', () => {
  const r = room(['alpha']);
  r.paint();
  for (const t of ['task', 'bug', 'feature', 'epic', 'chore']) {
    assert.ok(r.els['#beadform-type'].innerHTML.includes(`data-value="${t}"`), `no chip for ${t}`);
  }
  for (const p of [0, 1, 2, 3, 4]) {
    assert.ok(r.els['#beadform-priority'].innerHTML.includes(`data-value="${p}"`), `no chip for P${p}`);
  }
  // What the form opens on, which is what most beads are filed as.
  assert.match(r.els['#beadform-type'].innerHTML, /data-value="task"\s*\n?\s*aria-pressed="true"/);
});

await check('a repo the space no longer allows does not stay selected', () => {
  // The picker moves under the form — the sheet is open across a repaint. A workspace
  // held from before the move would file into a repo you are not looking at, which is
  // the one thing the picker exists to stop.
  const r = room(['alpha', 'beta']);
  r.paint();
  r.form.workspace = 'gone';
  r.paint();
  assert.equal(r.form.workspace, 'alpha');
});

for (const s of servers) s.close();
cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
