#!/usr/bin/env node
/**
 * Approve, discuss and cancel on a JIRA ticket row — the gate, and what it does to beads.
 *
 *     npm test
 *     node test/jiragate.mjs
 *
 * test/jiracancel.mjs owns the earmark itself: keyed by the ticket, never pruned, on
 * disk. This is everything that acts on it — the three decisions (lib/jiragate.js), the
 * three routes behind them, and the row that offers them (public/app.js).
 *
 * What is asserted, and why each is here rather than assumed:
 *
 * 1. **Approve endorses the epic *and its children*.** This is the whole of why approve
 *    is a route of its own rather than `/api/bead/endorse` with an id the phone already
 *    has: which beads make up a ticket is a `bd list --parent` at the server's end, and
 *    an approve that took the marker off the epic alone would put a container in the
 *    ready queue with nothing workable in it. A closed child is left closed.
 * 2. **Nothing is workable before it.** The negative property the whole epic hangs on —
 *    asserted by reading the labels either side of the tap, since `unendorsed` is what
 *    `openWorkSession` refuses on.
 * 3. **Cancel closes the epic and earmarks the ticket — unless it is already endorsed.**
 *    Then the bead is left completely alone: by that point it is real work, possibly
 *    with a branch, and this is bc-uz6e's answer applied to the other end of the same
 *    problem. The earmark is written either way, because "stop proposing this" and
 *    "throw the work away" are two claims and only the first is what cancel means.
 * 4. **The earmark is written even when `bd` will not answer.** Getting the record down
 *    is the decision; closing the bead is tidying up after it. A cancel that reported a
 *    failure and left the ticket to come back on the next sweep is the loop this exists
 *    to prevent.
 * 5. **Beadify reopens rather than re-files, and produces one epic, not two.** The ref
 *    survives a close, so the filer's first net finds the closed epic and files nothing —
 *    which means without the reopen a beadified ticket would come back with a closed bead
 *    that no sweep would ever replace. Asserted by running the real filer afterwards.
 * 6. **The row draws the three states and never offers a button that would 409.** The
 *    real renderer is sliced out of public/app.js and run over fixtures, the way
 *    test/jirarow.mjs reads the row itself.
 *
 * `bd` is a stub binary over a JSON file, as in test/endorsequeue.mjs. The routes are
 * exercised over a real socket against `createApp`, because what the routes do to the
 * filer's memory only exists inside a running app.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiragate-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { createEpicFiler, TICKET_LABEL } = await import(LIB('jiraepic.js'));
const { STATE_KEY, isCancelled, cancelledRecord } = await import(LIB('jiracancel.js'));
const { approveTicket, beadifyTicket, cancelTicketAndEpic, CANCELLED_PREFIX } = await import(LIB('jiragate.js'));
const { saveState } = await import(LIB('config.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, keyed by workspace directory — the shape test/endorsequeue.mjs
 * uses, with the four verbs this feature actually reaches for.
 *
 * `list` refuses a flag it has not been taught, so a future call site that reached for
 * one this stub silently ignored fails here rather than passing against a fiction.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
// --json off, and --actor <who> off with it: Bd.run appends the actor to every
// invocation and it is not a flag any verb here reads.
const raw = process.argv.slice(2).filter((a) => a !== '--json');
const args = [];
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--actor') { i++; continue; }
  args.push(raw[i]);
}
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const dir = process.env.BEADS_DIR || '';
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const w = world[dir];
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(world, null, 2));
if (!w) die('no beads database found in ' + dir);
if (w.broken) die('Error: dolt: could not open database');
const all = () => Object.values(w.issues || {});

if (args[0] === 'show') {
  const issue = (w.issues || {})[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list') {
  const known = ['list', '--all', '--limit', '0', '--parent', '--label', '--status'];
  const bad = args.find((a) => a.startsWith('--') && !known.includes(a));
  if (bad) die('unknown flag for this stub: ' + bad);
  const parent = one('--parent');
  const label = one('--label');
  const rows = all()
    .filter((i) => !parent || i.parent === parent)
    .filter((i) => !label || (i.labels || []).includes(label))
    .filter((i) => args.includes('--all') || i.status !== 'closed');
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'close') {
  const issue = (w.issues || {})[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.status = 'closed';
  issue.close_reason = one('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = (w.issues || {})[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--status')) issue.status = one('--status');
  save();
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = (w.issues || {})[args[2]];
  if (!issue) die('Error: no issue found matching "' + args[2] + '"');
  issue.labels = (issue.labels || []).filter((l) => l !== args[3]);
  save();
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const dirOf = (name) => path.join(tmp, name, '.beads');
for (const name of ['alpha']) fs.mkdirSync(dirOf(name), { recursive: true });
const ALPHA = { name: 'alpha', dir: dirOf('alpha') };

/** One bead as `bd list --json` hands it back — bd's field names, not a card's. */
const bead = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [UNENDORSED],
  created_at: '2026-08-13T10:00:00Z',
  updated_at: '2026-08-13T10:00:00Z',
  ...extra,
});

/**
 * The tracker as it stands the moment a ticket has arrived: one held epic carrying the
 * ref, two held children under it, and one child already revoked.
 */
function world() {
  return {
    [ALPHA.dir]: {
      issues: {
        'aa-epic': bead('aa-epic', {
          title: 'TECH-1 — the login redirect loop',
          issue_type: 'epic',
          priority: 1,
          external_ref: 'jira-TECH-1',
          labels: [UNENDORSED, TICKET_LABEL],
        }),
        'aa-one': bead('aa-one', { parent: 'aa-epic' }),
        'aa-two': bead('aa-two', { parent: 'aa-epic' }),
        'aa-old': bead('aa-old', { parent: 'aa-epic', status: 'closed' }),
        // Somebody else's held bead in the same workspace, with no ref and no parent:
        // it must come through every act here untouched.
        'aa-other': bead('aa-other'),
      },
    },
  };
}

const writeWorld = (w) => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const readWorld = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const issueOf = (id) => readWorld()[ALPHA.dir].issues[id];
const labelsOf = (id) => issueOf(id).labels || [];

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/** A filer whose memory has been filled the way a real sweep fills it. */
async function filerThatHasSwept() {
  const filer = createEpicFiler({ bd });
  await filer.sweep({}, [ALPHA], [{ workspace: 'alpha', state: 'ok', tickets: [{ key: 'TECH-1' }] }]);
  return filer;
}

const reset = () => {
  writeWorld(world());
  saveState({ [STATE_KEY]: {} });
};

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.stack || err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

console.log('\napprove, discuss and cancel on a JIRA ticket\n');

/* ------------------------------------------------------------------- approve */

await check('before it, the epic and its children are all held — which is the whole gate', () => {
  reset();
  for (const id of ['aa-epic', 'aa-one', 'aa-two']) {
    assert.ok(labelsOf(id).includes(UNENDORSED), `${id} must arrive held or nothing else here means anything`);
  }
});

await check('approve endorses the epic and its open children in one act', async () => {
  reset();
  const filer = await filerThatHasSwept();
  const out = await approveTicket(bd, ALPHA, 'TECH-1', { filer });
  assert.equal(out.epic, 'aa-epic');
  assert.equal(out.children, 2, 'the closed child is not one of them');
  assert.deepEqual(out.ok.map((r) => r.id).sort(), ['aa-epic', 'aa-one', 'aa-two']);
  for (const id of ['aa-epic', 'aa-one', 'aa-two']) {
    assert.ok(!labelsOf(id).includes(UNENDORSED), `${id} is workable now`);
  }
  assert.ok(labelsOf('aa-old').includes(UNENDORSED), 'a revoked child is not endorsed back into the queue');
  assert.ok(
    labelsOf('aa-other').includes(UNENDORSED),
    'and a held bead in the same workspace that is nothing to do with the ticket is untouched'
  );
});

await check('and the row stops offering it: the filer knows the hold came off', async () => {
  reset();
  const filer = await filerThatHasSwept();
  assert.deepEqual(filer.epicFor('alpha', 'TECH-1'), { id: 'aa-epic', held: true });
  await approveTicket(bd, ALPHA, 'TECH-1', { filer });
  assert.deepEqual(
    filer.epicFor('alpha', 'TECH-1'),
    { id: 'aa-epic', held: false },
    'without this the row offers approve until the next authoritative read, which on a quiet machine is never'
  );
});

await check('a second tap is a 200 that says nothing happened, not an error', async () => {
  const filer = await filerThatHasSwept();
  const out = await approveTicket(bd, ALPHA, 'TECH-1', { filer });
  assert.equal(out.failed.length, 0, 'endorsing is idempotent all the way down (lib/verdict.js)');
  assert.ok(out.ok.every((r) => r.endorsed === false), 'and it reports that there was nothing to take off');
});

await check('a ticket whose epic has not been filed yet is refused rather than half done', async () => {
  reset();
  const filer = await filerThatHasSwept();
  await assert.rejects(() => approveTicket(bd, ALPHA, 'TECH-9', { filer }), /no bead yet/);
});

await check('the epic is found in the tracker when the filer has no memory of it', async () => {
  reset();
  // A daemon that has not swept since it started, or an epic another machine filed. The
  // memory is empty and the answer must still be right.
  const out = await approveTicket(bd, ALPHA, 'TECH-1', { filer: createEpicFiler({ bd }) });
  assert.equal(out.epic, 'aa-epic', 'read off bd list --all by ref, the way the filer decides');
});

/* -------------------------------------------------------------------- cancel */

await check('cancel earmarks the ticket and closes the epic with a reason that names it', async () => {
  reset();
  const filer = await filerThatHasSwept();
  const out = await cancelTicketAndEpic(bd, ALPHA, 'TECH-1', { filer });
  assert.equal(out.bead, 'closed');
  assert.equal(issueOf('aa-epic').status, 'closed');
  assert.ok(issueOf('aa-epic').close_reason.startsWith(CANCELLED_PREFIX));
  assert.ok(issueOf('aa-epic').close_reason.includes('TECH-1'), 'the only way back to the ticket in six months');
  assert.ok(labelsOf('aa-epic').includes(UNENDORSED), 'the marker stays: the history of what was turned down');
  assert.equal(isCancelled('alpha', 'TECH-1'), true);
  assert.equal(cancelledRecord('alpha', 'TECH-1').bead, 'aa-epic', 'carried so beadify can reopen it');
});

await check('an epic that has already been approved is left completely alone', async () => {
  reset();
  const filer = await filerThatHasSwept();
  await approveTicket(bd, ALPHA, 'TECH-1', { filer });
  const out = await cancelTicketAndEpic(bd, ALPHA, 'TECH-1', { filer });
  assert.equal(out.bead, 'endorsed');
  assert.equal(issueOf('aa-epic').status, 'open', 'by now it is real work — possibly with a branch on it');
  assert.equal(isCancelled('alpha', 'TECH-1'), true, 'and the ticket still stops being proposed');
});

await check('the earmark is written even when bd will not answer at all', async () => {
  reset();
  writeWorld({ [ALPHA.dir]: { broken: true } });
  const out = await cancelTicketAndEpic(bd, ALPHA, 'TECH-1', { filer: createEpicFiler({ bd }) });
  assert.equal(out.bead, 'none');
  assert.equal(
    isCancelled('alpha', 'TECH-1'),
    true,
    'a cancel that reported a failure and let the ticket come back next sweep is the loop this prevents'
  );
});

/* ------------------------------------------------------------------- beadify */

await check('beadify lifts the earmark, reopens the epic, and files no second one', async () => {
  reset();
  const filer = await filerThatHasSwept();
  await cancelTicketAndEpic(bd, ALPHA, 'TECH-1', { filer });
  const out = await beadifyTicket(bd, ALPHA, 'TECH-1', { filer });
  assert.equal(out.restored, true);
  assert.equal(out.reopened, true);
  assert.equal(issueOf('aa-epic').status, 'open');
  assert.equal(isCancelled('alpha', 'TECH-1'), false);

  // The real filer, over the ticket that is now a row again: the ref is still on the
  // epic, so the first net finds it and nothing is created. This is the assertion that
  // makes the reopen load-bearing rather than tidy — without it the ticket comes back
  // with a closed bead that no sweep will ever replace.
  const after = await filer.sweep({}, [ALPHA], [{ workspace: 'alpha', state: 'ok', tickets: [{ key: 'TECH-1' }] }]);
  assert.deepEqual(after.filed, [], 'one epic, not two');
  assert.equal(Object.keys(readWorld()[ALPHA.dir].issues).length, 5, 'and no bead was added anywhere');
});

await check('a ticket that was never cancelled is not an error', async () => {
  reset();
  const out = await beadifyTicket(bd, ALPHA, 'TECH-1', { filer: createEpicFiler({ bd }) });
  assert.equal(out.restored, false);
  assert.equal(out.reopened, false);
});

/* --------------------------------------------------------------------- the routes */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'jiragate-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ALPHA],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'x-beadcause-token': cfg.token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

await check('POST /api/jira/approve takes the ticket key and endorses the family', async () => {
  reset();
  const res = await call('POST', '/api/jira/approve', { workspace: 'alpha', key: 'TECH-1' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.epic, 'aa-epic');
  assert.deepEqual(res.json.applied.sort(), ['aa-epic', 'aa-one', 'aa-two']);
  assert.equal(res.json.ok, true);
});

await check('POST /api/jira/cancel earmarks it, and beadify puts it back', async () => {
  reset();
  const gone = await call('POST', '/api/jira/cancel', { workspace: 'alpha', key: 'TECH-1' });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal(gone.json.bead, 'closed');
  assert.equal(issueOf('aa-epic').status, 'closed');

  const back = await call('POST', '/api/jira/beadify', { workspace: 'alpha', key: 'TECH-1' });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.reopened, true);
  assert.equal(issueOf('aa-epic').status, 'open');
});

await check('a body that does not name a JIRA key is refused before anything is written', async () => {
  reset();
  const res = await call('POST', '/api/jira/cancel', { workspace: 'alpha', key: '../../etc' });
  assert.equal(res.status, 400);
  assert.equal(isCancelled('alpha', '../../etc'), false, 'an earmark nobody could ever cancel back');
});

await check('a GET is not one of these — all three write, so all three are POST only', async () => {
  reset();
  const res = await call('GET', '/api/jira/approve');
  assert.notEqual(res.status, 200, `a GET must not endorse anything: ${JSON.stringify(res.json)}`);
  assert.ok(labelsOf('aa-epic').includes(UNENDORSED), 'and nothing moved');
});

await check('all three are registered the way the route table can see them', async () => {
  // `routeTable` reads literal `if (p === '…' && req.method === '…')` out of the
  // handler's text, and test/routes.mjs asserts every path it finds has a README row.
  // A route written any other way — a `||` chain over three paths, which is how these
  // began — is invisible to both, which means undocumented *and* free to collide.
  const { routeTable } = await import(LIB('server.js'));
  const table = routeTable(app.handler);
  for (const path of ['/api/jira/approve', '/api/jira/cancel', '/api/jira/beadify']) {
    assert.ok(table.includes(`POST ${path}`), `${path} is not in the derived route table`);
  }
});

for (const s of servers || []) s.close?.();

/* ------------------------------------------------------------------------ the row */

/**
 * The real renderer, sliced out of public/app.js and run over fixtures — the pattern
 * test/jirarow.mjs uses, and for its reason: the inbox needs a whole document to run, so
 * what is checked here is what a refactor would break silently.
 */
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function sliceFn(name) {
  const start = APP.indexOf(`  function ${name}(`);
  assert.ok(start !== -1, `${name} is not in public/app.js under that name any more`);
  let depth = 0;
  let i = APP.indexOf('{', start);
  for (let j = i; j < APP.length; j += 1) {
    if (APP[j] === '{') depth += 1;
    else if (APP[j] === '}') {
      depth -= 1;
      if (depth === 0) return APP.slice(start, j + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const sandbox = {
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  jiraSaid: new Map(),
  jiraBusy: new Set(),
  jiraCancelLabel: (armed) => (armed ? 'Tap again — it stops coming back' : 'Cancel'),
  state: { armed: null },
};
vm.createContext(sandbox);
vm.runInContext(sliceFn('jiraActsHtml').replace(/^ {2}function/, 'function'), sandbox);

const row = (jira) => ({ key: `jira:alpha/${jira.key}`, workspace: 'alpha', jira });

await check('with no bead yet the row says so and offers no button that would 409', () => {
  const html = sandbox.jiraActsHtml(row({ key: 'TECH-1', bead: null, held: null }));
  assert.ok(html.includes('still being filed'), 'the epic arrives within the minute; a phone may open inside it');
  assert.ok(!html.includes('jira-approve'), 'approve on a ticket with no epic is a refusal, so it is not offered');
  assert.ok(html.includes('jira-cancel'), 'but cancelling one is exactly what the earmark is keyed to allow');
});

await check('a held ticket offers approve and a link into the discussion that already exists', () => {
  const html = sandbox.jiraActsHtml(row({ key: 'TECH-1', bead: 'aa-epic', held: true }));
  assert.ok(html.includes('data-act="jira-approve"'), 'approve');
  assert.ok(
    html.includes('/endorse?bead=alpha%2Faa-epic&amp;talk=1'),
    'discuss is the endorsement queue’s own thread on this bead, not a second one on the row'
  );
  assert.ok(html.includes('data-tkt="TECH-1"'), 'aimed at the ticket key — the server resolves which beads that is');
});

await check('an approved ticket says which bead it became instead of offering approve again', () => {
  const html = sandbox.jiraActsHtml(row({ key: 'TECH-1', bead: 'aa-epic', held: false }));
  assert.ok(!html.includes('data-act="jira-approve"'));
  assert.ok(html.includes('aa-epic'));
  assert.ok(html.includes('jira-cancel'), 'cancel stays: "stop showing me this" outlives the approval');
});

await check('cancel arms, and the second tap says what it will not take back', () => {
  const plain = sandbox.jiraActsHtml(row({ key: 'TECH-1', bead: 'aa-epic', held: true }));
  assert.ok(!plain.includes('confirm'), 'one tap only arms it');
  sandbox.state.armed = 'jira:alpha/TECH-1|jira-cancel';
  const armed = sandbox.jiraActsHtml(row({ key: 'TECH-1', bead: 'aa-epic', held: true }));
  assert.ok(armed.includes('confirm'));
  assert.ok(armed.includes('stops coming back'), 'the consequence goes between the two taps, never after them');
  sandbox.state.armed = null;
});

await check('the click handler posts the ticket key, not a bead id', () => {
  // A static read, because what would break silently is the *body*: `/api/jira/approve`
  // resolves the epic itself, and a client that started sending `id` would be refused by
  // the key check with a message about a JIRA key that names a bead.
  for (const route of ['/api/jira/approve', '/api/jira/cancel']) {
    const at = APP.indexOf(route);
    assert.ok(at !== -1, `${route} is not called from public/app.js`);
    const body = APP.slice(at, at + 300);
    assert.ok(/key: btn\.dataset\.tkt/.test(body), `${route} must be given the ticket key`);
    assert.ok(/workspace: btn\.dataset\.ws/.test(body), `${route} must name the workspace JIRA was read from`);
  }
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
