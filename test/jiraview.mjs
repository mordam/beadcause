#!/usr/bin/env node
/**
 * The JIRA ticket view — opened over the tab, drawn before the reading has finished,
 * and the beadify that undoes a cancel (bc-0i27.6).
 *
 *     npm test
 *     node test/jiraview.mjs
 *
 * test/jirarow.mjs owns the shut row and test/jiragate.mjs owns the three decisions on
 * it. This is the screen behind the tap, and five things about it fail silently without
 * a suite:
 *
 * 1. **It opens over the tab rather than instead of it.** `.card.open` is the fixed
 *    full-screen sheet a question and a pull request already open into, and a detail
 *    that gave the tab back differently from the rest of the app is the bug people
 *    report as the app losing their place. Asserted on the real renderer, sliced out of
 *    public/app.js and run over fixtures — the same VM test/jirarow.mjs uses.
 * 2. **It draws before the ingestion has finished, and fills the bead half in later.**
 *    The whole point of the step: the decomposition may still be running and the ticket
 *    is what you read to decide either way. So the view is built from the *row*, which
 *    refreshes on the ordinary inbox poll, and never waits on anything.
 * 3. **A JIRA that will not answer is a sentence, not an empty card.** The row's facts,
 *    the epic and the buttons are all still true and still act; the one thing lost is
 *    the description. Asserted over the wire, because the route is where it would be
 *    turned back into a 500.
 * 4. **A cancelled ticket's view offers exactly one thing.** Not also approve: the epic
 *    is closed and the earmark is on, so approving would endorse a closed bead and the
 *    next sweep would take the ticket away again.
 * 5. **Beadify puts it back *through ingestion*.** The ingester skips any ticket it has
 *    an answer about, so without dropping this one ticket's entry a cancel taken over a
 *    failed reading would come back unreadable forever, with no surface left to retry
 *    it. That is the one line in this feature with no visible symptom.
 *
 * No network and no tracker: the JIRA read is `fetchImpl`, which is the seam lib/jira.js
 * actually calls, and `bd` is a stub binary over a JSON file for the one route that
 * needs a real one.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-jiraview-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

// The environment wins over the file in lib/atlassian.js, and this Mac's own shell
// exports one inside a work directory — deleted here for the reason test/jira-poll.mjs
// deletes it: a suite that read the real token would be a suite that could reach JIRA.
delete process.env.JIRA_API_TOKEN;

const { THREAD_LIMIT, ticketText, ticketView } = await import(LIB('jiraview.js'));
const { writeToken } = await import(LIB('jira.js'));
const { STATE_KEY, cancelTicket } = await import(LIB('jiracancel.js'));
const { beadifyTicket } = await import(LIB('jiragate.js'));
const { createIngester, stateKey } = await import(LIB('jiraingest.js'));
const { saveState } = await import(LIB('config.js'));

writeToken('alpha', 'a-token');

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
    console.log(`      ${String(err.stack || err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/* --------------------------------------------------------------- reading the ticket */

const ALPHA = { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') };
fs.mkdirSync(ALPHA.dir, { recursive: true });

const CFG = { jira: { alpha: { enabled: true, url: 'https://alpha.atlassian.net', email: 'you@alpha.dev' } } };

const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** JIRA's answer for one issue, with as many comments as asked for. */
function issueBody(comments = 1) {
  return {
    key: 'TECH-7',
    fields: {
      summary: 'The meter reads zero after a reconnect',
      description: { type: 'doc', content: [para('It reads zero for about a minute, then recovers.')] },
      comment: {
        comments: Array.from({ length: comments }, (_, i) => ({
          author: { displayName: `person ${i}` },
          created: '2026-08-01T09:00:00.000+0000',
          body: { type: 'doc', content: [para(`comment ${i}`)] },
        })),
      },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      labels: ['meters', 'api'],
      parent: { key: 'TECH-1', fields: { summary: 'Reconnect handling' } },
    },
  };
}

/** Nothing in this suite may touch the network — a JIRA read here is a bug in the suite. */
const noNetwork = async () => {
  throw new Error('this suite does not go to the network');
};

const fetchOk = (comments = 1) => async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify(issueBody(comments));
  },
});

/** A `bd` that is only ever asked one thing here, and can be told to refuse. */
const fakeBd = ({ kids = [], refuse = false } = {}) => ({
  async children() {
    if (refuse) throw new Error('dolt: could not open database');
    return kids;
  },
});

console.log('\nreading the ticket — the half a row cannot carry\n');

await check('the description and the thread arrive as text, with the ticket’s own facts', async () => {
  const out = await ticketText(fakeBd(), ALPHA, CFG, 'TECH-7', { fetchImpl: fetchOk(2) });
  assert.equal(out.ok, true);
  assert.match(out.description, /reads zero for about a minute/);
  assert.equal(out.comments.length, 2);
  assert.equal(out.comments[0].author, 'person 0');
  assert.equal(out.type, 'Bug');
  assert.equal(out.priority, 'High');
  assert.deepEqual(out.labels, ['meters', 'api']);
  // The ticket's parent *in JIRA*, which is a different thing from the epic beadcause
  // filed for it — carried separately so the view can say which is which.
  assert.deepEqual(out.parent, { key: 'TECH-1', summary: 'Reconnect handling' });
});

await check('a long thread is capped at the newest, and says how many it did not send', async () => {
  const out = await ticketText(fakeBd(), ALPHA, CFG, 'TECH-7', { fetchImpl: fetchOk(THREAD_LIMIT + 5) });
  assert.equal(out.comments.length, THREAD_LIMIT, 'a five-year-old ticket must not arrive whole on a phone');
  assert.equal(out.omitted, 5, 'a thread silently missing its middle is worse than one that says it is');
  // The tail, in the order a thread is read in: what was said last week is what the
  // decision is about, and the first comment on an old ticket filed itself.
  assert.equal(out.comments[0].author, 'person 5');
  assert.equal(out.comments[THREAD_LIMIT - 1].author, `person ${THREAD_LIMIT + 4}`);
});

await check('a JIRA that will not answer is a field, never a throw', async () => {
  const out = await ticketText(fakeBd(), ALPHA, CFG, 'TECH-7', {
    fetchImpl: async () => ({ ok: false, status: 401, async text() { return '{}'; } }),
  });
  assert.equal(out.ok, false);
  assert.ok(out.error, 'a refusal with no reason is a screen that says nothing');
});

await check('and so is JIRA being switched off for the workspace', async () => {
  const out = await ticketText(fakeBd(), ALPHA, {}, 'TECH-7', { fetchImpl: fetchOk() });
  assert.equal(out.ok, false);
  assert.match(out.error, /not on for alpha/);
});

console.log('\nand what beadcause made of it');

await check('the children come off the epic the caller already has', async () => {
  const kids = [{ id: 'aa-one', title: 'one', status: 'open' }];
  const out = await ticketView(fakeBd({ kids }), ALPHA, CFG, 'TECH-7', {
    epic: 'aa-epic',
    fetchImpl: fetchOk(),
  });
  assert.equal(out.epic, 'aa-epic');
  assert.deepEqual(out.children, kids);
  assert.equal(out.childrenError, null);
});

await check('with no epic yet there are no children, which is the honest answer', async () => {
  // The minute between a ticket arriving and its epic being filed. An empty list here
  // would read as a decomposition into nothing, which is a different picture entirely.
  const asked = [];
  const bd = { async children(...args) { asked.push(args); return [{ id: 'aa-one' }]; } };
  const out = await ticketView(bd, ALPHA, CFG, 'TECH-7', { fetchImpl: fetchOk() });
  assert.deepEqual(out.children, []);
  assert.equal(asked.length, 0, 'a bd list --parent was spent on a ticket with no parent to list');
});

await check('a tracker that will not answer costs the children and not the ticket', async () => {
  const out = await ticketView(fakeBd({ refuse: true }), ALPHA, CFG, 'TECH-7', {
    epic: 'aa-epic',
    fetchImpl: fetchOk(),
  });
  assert.match(out.childrenError, /dolt/);
  assert.equal(out.read.ok, true, 'the ticket is still readable — the two halves fail apart');
});

await check('the earmark is read from the record rather than trusted from the client', async () => {
  saveState({ [STATE_KEY]: {} });
  const clean = await ticketView(fakeBd(), ALPHA, CFG, 'TECH-7', { fetchImpl: fetchOk() });
  assert.equal(clean.cancelled, null);
  cancelTicket({ workspace: 'alpha', key: 'TECH-7', bead: 'aa-epic' });
  const after = await ticketView(fakeBd(), ALPHA, CFG, 'TECH-7', { fetchImpl: fetchOk() });
  assert.equal(after.cancelled?.bead, 'aa-epic', 'the view could not tell it was looking at a cancelled ticket');
  saveState({ [STATE_KEY]: {} });
});

/* ----------------------------------------------------- beadify and the ingester */

console.log('\nbeadify puts it back through ingestion');

await check('a ticket cancelled over a failed reading is read again, not left unreadable', async () => {
  // The one line in this feature with no visible symptom. `sweep` skips any ticket the
  // ingester has an answer about, and `failed` is an answer — so without the forget the
  // row would come back saying *could not be read* with nothing anywhere that retries.
  saveState({ [STATE_KEY]: {} });
  const ing = createIngester({ bd: fakeBd(), run: async () => '', fetchImpl: noNetwork });
  ing.forget();
  // Put a settled failure in its memory the way a real ingestion leaves one.
  await ing.sweep(CFG, [{ workspace: ALPHA, ticket: { key: 'TECH-7' }, epic: 'aa-epic' }]);
  await ing.drain();
  assert.ok(ing.stateFor('alpha', 'TECH-7'), 'the ingester has no opinion — this check is staged wrong');

  cancelTicket({ workspace: 'alpha', key: 'TECH-7', bead: null });
  await beadifyTicket({ async show() { return null; } }, ALPHA, 'TECH-7', { ingester: ing });
  assert.equal(ing.stateFor('alpha', 'TECH-7'), null, 'the reading was remembered across the beadify');
  saveState({ [STATE_KEY]: {} });
});

await check('and only that ticket — the workspace’s others are not made to pay for it', async () => {
  const ing = createIngester({ bd: fakeBd(), run: async () => '', fetchImpl: noNetwork });
  ing.forget();
  await ing.sweep(CFG, [
    { workspace: ALPHA, ticket: { key: 'TECH-7' }, epic: 'aa-epic' },
    { workspace: ALPHA, ticket: { key: 'TECH-8' }, epic: 'aa-other' },
  ]);
  await ing.drain();
  ing.forgetTicket(ALPHA, 'TECH-7');
  assert.equal(ing.stateFor('alpha', 'TECH-7'), null);
  assert.ok(ing.stateFor('alpha', 'TECH-8'), 'a beadify cost every other ticket a bd list --parent');
  assert.equal(stateKey('alpha', 'TECH-8'), 'alpha::TECH-8');
});

/* ------------------------------------------------------------------- the route */

console.log('\nthe route');

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const raw = process.argv.slice(2).filter((a) => a !== '--json');
const args = [];
for (let i = 0; i < raw.length; i++) { if (raw[i] === '--actor') { i++; continue; } args.push(raw[i]); }
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const rows = Object.values(world.issues || {});
if (args[0] === 'list') {
  const parent = one('--parent');
  process.stdout.write(JSON.stringify(rows.filter((i) => !parent || i.parent === parent)));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  WORLD,
  JSON.stringify({
    issues: {
      'aa-one': { id: 'aa-one', title: 'the reconnect path', status: 'open', parent: 'aa-epic', priority: 2 },
      'aa-two': { id: 'aa-two', title: 'a regression test', status: 'closed', parent: 'aa-epic', priority: 2 },
      'aa-none': { id: 'aa-none', title: 'nothing to do with it', status: 'open', priority: 2 },
    },
  })
);

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: 'http://127.0.0.1',
  token: 'jiraview-token',
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
  // JIRA deliberately off for this workspace, which is what keeps the route's own test
  // off the network: the read fails before a socket is opened, and *that* is the case
  // worth exercising over the wire — everything else on the answer still has to arrive.
  jira: {},
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    req.end();
  });

await check('GET /api/jira/ticket answers with the children even when JIRA cannot be read', async () => {
  const res = await get('/api/jira/ticket?workspace=alpha&key=TECH-7&epic=aa-epic');
  assert.equal(res.status, 200, 'a JIRA that will not answer must not take the whole view with it');
  assert.equal(res.json.read.ok, false);
  assert.ok(res.json.read.error, 'the reason is what turns a blank half into a sentence');
  assert.deepEqual(
    res.json.children.map((c) => c.id).sort(),
    ['aa-one', 'aa-two'],
    'the closed child comes too — an epic whose children were revoked is a picture worth seeing'
  );
});

await check('a request that does not name a JIRA key is refused', async () => {
  const res = await get('/api/jira/ticket?workspace=alpha&key=aa-epic');
  assert.equal(res.status, 400);
});

await check('and one whose epic is not a bead id is refused before bd is reached', async () => {
  const res = await get('/api/jira/ticket?workspace=alpha&key=TECH-7&epic=..%2F..%2Fetc');
  assert.equal(res.status, 400);
});

for (const server of servers) server.close();

/* ------------------------------------------------------------------ the renderer */

console.log('\nwhat the view draws');

const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** Lift one declaration out of public/app.js — test/jirarow.mjs's slicer, verbatim. */
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

const sandbox = vm.createContext({ Date, String, Math, JSON, Number, Set, Array, encodeURIComponent });
vm.runInContext(
  [
    lift('const esc = ('),
    lift('function relTime(iso)'),
    lift('function graphUrl(q)'),
    lift('function jiraIngestHtml(row)'),
    lift('const jiraCancelLabel = ('),
    lift('function jiraActsHtml(row)'),
    lift('function jiraBeadsHtml(row, detail)'),
    lift('function jiraReadHtml(detail)'),
    lift('function jiraFullHtml(row)'),
    lift('function jiraRowHtml(row)'),
    lift('const cancelledTicketRows = ()'),
    lift('function cancelledTicketsHtml()'),
    lift('function strandedCancelsHtml(stranded)'),
  ].join('\n'),
  Object.assign(sandbox, {
    state: {
      armed: null,
      open: new Set(),
      cancelledTickets: [],
      strandedCancels: [],
      space: 'all',
      workspace: 'all',
      cancelledFold: false,
    },
    jiraSaid: new Map(),
    jiraBusy: new Set(),
    // Only reached for a row whose own `space` is null, which no fixture here has.
    spaceForWorkspace: () => null,
  })
);

const row = (jira, extra = {}) => ({
  jira,
  key: `jira:alpha/${jira.key}`,
  workspace: 'alpha',
  space: 'Work',
  ...extra,
});

const HELD = {
  key: 'TECH-7',
  summary: 'The meter reads zero after a reconnect',
  status: 'In Progress',
  updated: new Date(Date.now() - 3600 * 1000).toISOString(),
  url: 'https://alpha.atlassian.net/browse/TECH-7',
  bead: 'aa-epic',
  held: true,
  ingest: { state: 'done', epic: 'aa-epic', children: 2 },
};

/** The open half, drawn the way `render()` draws it: the key is in `state.open`. */
function open(jira, detail = null) {
  const r = row(jira);
  sandbox.state.open = new Set([r.key]);
  if (detail) sandbox.state.ticketDetail = new Map([[r.key, detail]]);
  const html = sandbox.jiraRowHtml(r);
  sandbox.state.open = new Set();
  return html;
}

sandbox.state.ticketDetail = new Map();

await check('a tap opens it over the tab — the same fixed sheet everything else opens into', () => {
  const html = open(HELD);
  assert.match(html, /class="card jira-card open"/, 'not `.card.open`, so it is not over the tab at all');
  // And the way back is the one every other card has. There is no ✕ and no navigation:
  // a card that collapses into the list *is* the view it opened over.
  assert.match(html, /data-act="collapse"/, 'no way back to the list');
  assert.match(html, /class="card-head"/);
  assert.match(html, /class="brief"/);
  assert.match(html, /class="freeform jira-freeform"/, 'the buttons are not pinned');
});

await check('the title becomes the link out to JIRA, which the shut row is not', () => {
  const html = open(HELD);
  assert.match(html, /href="https:\/\/alpha\.atlassian\.net\/browse\/TECH-7"/);
  assert.match(html, /rel="noopener noreferrer"/, 'a target=_blank without this is a tabnabbing hole');
});

await check('it draws before the ingestion has finished, and says which half is missing', () => {
  // The whole point of the step: the decomposition may still be running and the ticket
  // is what you read to decide either way.
  const early = open({ ...HELD, bead: null, held: null, ingest: null });
  assert.match(early, /still being filed/, 'a ticket opened in the first minute must say so');
  assert.match(early, /The meter reads zero/, 'and must still be readable, which is the point');
  const reading = open({ ...HELD, ingest: { state: 'reading', epic: 'aa-epic', children: 0 } });
  assert.match(reading, /reading it into beads/);
  assert.match(reading, /aa-epic/, 'the id is there the moment the epic is filed, long before the children are');
});

await check('the children are drawn with their status, closed ones included', () => {
  const html = open(HELD, {
    loading: false,
    read: { ok: true, description: 'It reads zero.', comments: [] },
    children: [
      { id: 'aa-one', title: 'the reconnect path', status: 'open' },
      { id: 'aa-two', title: 'a regression test', status: 'closed' },
    ],
  });
  assert.match(html, /aa-one/);
  assert.match(html, /jira-kid shut/, 'a revoked child reads the same as a waiting one');
});

await check('the ticket’s own words are text, never markup', () => {
  const html = open(HELD, {
    loading: false,
    read: {
      ok: true,
      description: '<img src=x onerror=alert(1)>',
      comments: [{ author: '<b>sam</b>', at: null, text: '<script>x</script>' }],
      labels: ['api'],
      type: 'Bug',
    },
  });
  assert.doesNotMatch(html, /<img|<script>/, 'a JIRA description reached the DOM as markup');
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;b&gt;sam/);
});

await check('and a read that failed says so under a card that is otherwise whole', () => {
  const html = open(HELD, { loading: false, read: { ok: false, error: 'the token expired' } });
  assert.match(html, /the token expired/);
  assert.match(html, /aa-epic/, 'the epic and the buttons are still there — only the description is lost');
  assert.match(html, /data-act="jira-approve"/);
});

console.log('\nand what a cancelled one offers');

const CANCELLED = {
  ...HELD,
  cancelled: { workspace: 'alpha', key: 'TECH-7', bead: 'aa-epic', at: new Date(Date.now() - 7200 * 1000).toISOString(), by: null },
};

await check('one Beadify, and nothing that would put the ticket straight back in the queue', () => {
  const html = open(CANCELLED);
  assert.match(html, /data-act="jira-beadify"/, 'the way back is not offered anywhere');
  assert.doesNotMatch(html, /data-act="jira-approve"/, 'approving would endorse a closed bead');
  assert.doesNotMatch(html, /data-act="jira-cancel"/, 'cancelling a cancelled ticket is not a thing to offer');
  assert.match(html, /cancelled 2h ago/, 'when it was decided is half of deciding to take it back');
});

await check('and it is one tap, because it is the undo of the one that armed', () => {
  const html = open(CANCELLED);
  assert.doesNotMatch(html, /confirm/, 'an undo behind two taps is a decision you have to make twice');
});

await check('the fold at the foot of the list is how you reach one at all', () => {
  sandbox.state.cancelledTickets = [{ ...CANCELLED, workspace: 'alpha', space: 'Work' }];
  sandbox.state.cancelledFold = false;
  const shut = sandbox.cancelledTicketsHtml();
  assert.match(shut, /1 cancelled ticket\b/, 'the count is the whole of what a shut fold says');
  assert.doesNotMatch(shut, /jira-beadify/, 'shut, it is one line and not a list');
  sandbox.state.cancelledFold = true;
  const openFold = sandbox.cancelledTicketsHtml();
  assert.match(openFold, /data-act="jira-open"/, 'the row inside opens the same view');
  assert.match(openFold, /jira-beadify/);
});

await check('it obeys the space picker, so one space cannot put back another’s ticket', () => {
  sandbox.state.cancelledTickets = [{ ...CANCELLED, workspace: 'alpha', space: 'Work' }];
  sandbox.state.space = 'Home';
  assert.equal(sandbox.cancelledTicketsHtml(), '');
  sandbox.state.space = 'all';
  assert.ok(sandbox.cancelledTicketsHtml());
  sandbox.state.cancelledTickets = [];
  assert.equal(sandbox.cancelledTicketsHtml(), '', 'an empty fold is no fold, not an empty box');
});

/*
 * bc-0i27.19. The fold's second list: the cancel records the poller can no longer match.
 * Until this they were the one thing in the app with no surface at all — the fold above
 * is a filter over what the poller answered, so it could not show them, and nothing else
 * reads the store.
 */

const STRANDED = { workspace: 'alpha', key: 'TECH-4', bead: 'aa-old', at: '2026-08-01T00:00:00Z', by: null, space: 'Work' };

await check('a record with no ticket left is drawn, and the count says so', () => {
  sandbox.state.cancelledTickets = [{ ...CANCELLED, workspace: 'alpha', space: 'Work' }];
  sandbox.state.strandedCancels = [STRANDED];
  sandbox.state.cancelledFold = true;
  const html = sandbox.cancelledTicketsHtml();
  assert.match(html, /2 cancelled — 1 with no ticket left/, 'one number would have hidden the half nothing counted');
  assert.match(html, /TECH-4/);
  assert.match(html, /aa-old closed with it/, 'which bead it is NOT touching is the thing to say');
  assert.match(html, /data-act="jira-forget"/);
  assert.doesNotMatch(html.split('jira-orphans')[1], /jira-beadify/, 'beadify would reopen an epic for a dead ticket');
});

await check('and the fold exists for them alone — with no live cancelled ticket at all', () => {
  sandbox.state.cancelledTickets = [];
  sandbox.state.strandedCancels = [STRANDED];
  sandbox.state.cancelledFold = false;
  const shut = sandbox.cancelledTicketsHtml();
  assert.ok(shut, 'the whole bead is that this record had no screen');
  assert.match(shut, /1 cancelled — 1 with no ticket left/);
  assert.doesNotMatch(shut, /jira-forget/, 'shut is still one line');
  sandbox.state.cancelledFold = true;
  assert.match(sandbox.cancelledTicketsHtml(), /jira-forget/);
});

await check('they obey the space picker too, for the reason the rows above it do', () => {
  sandbox.state.cancelledTickets = [];
  sandbox.state.strandedCancels = [STRANDED];
  sandbox.state.space = 'Home';
  assert.equal(sandbox.cancelledTicketsHtml(), '');
  sandbox.state.space = 'all';
  assert.ok(sandbox.cancelledTicketsHtml());
  sandbox.state.strandedCancels = [];
  assert.equal(sandbox.cancelledTicketsHtml(), '', 'and an empty pair is no fold');
  sandbox.state.cancelledFold = false;
});

await check('the workspace rides each line, because two can carry the same ticket key', () => {
  sandbox.state.strandedCancels = [STRANDED, { ...STRANDED, workspace: 'beta' }];
  sandbox.state.cancelledFold = true;
  const html = sandbox.cancelledTicketsHtml();
  assert.match(html, /jira-orphan-ws">alpha/);
  assert.match(html, /jira-orphan-ws">beta/);
  assert.match(html, /data-ws="beta"/, 'and the drop has to name which of the two it means');
  sandbox.state.strandedCancels = [];
  sandbox.state.cancelledFold = false;
});

await check('the drop posts to its own route and moves nothing until the server agrees', () => {
  // Unlike beadify, which moves the row on the tap. This deletes the only surface there
  // is: an optimistic removal that then failed would leave the record off the screen with
  // nothing anywhere that could bring it back until the next payload.
  const at = APP.indexOf("act === 'jira-forget'");
  assert.notEqual(at, -1, 'the handler has gone');
  const fn = APP.slice(at, at + 1400);
  assert.match(fn, /'\/api\/jira\/forget'/);
  assert.ok(
    fn.indexOf('state.strandedCancels =') > fn.indexOf('await api('),
    'the line is dropped after the answer, not before the request'
  );
});

await check('and it opens itself when the card you are reading is one of its own', () => {
  // A repaint that hid the thing you were reading would be the fold eating the view —
  // which is exactly what a cancel taken from inside a ticket's own view produces.
  sandbox.state.cancelledTickets = [{ ...CANCELLED, workspace: 'alpha', space: 'Work' }];
  sandbox.state.cancelledFold = false;
  sandbox.state.open = new Set(['jira:alpha/TECH-7']);
  const html = sandbox.cancelledTicketsHtml();
  sandbox.state.open = new Set();
  assert.match(html, /card jira-card open/, 'the fold shut over the card that was open inside it');
});

console.log('\nwired into the page');

await check('the open ticket survives a poll — `byKey` can find a ticket row', () => {
  // `state.open` is pruned to the keys `byKey` still answers for on every refresh, so
  // without a `jira:` branch an open ticket collapsed itself every twenty-five seconds.
  const at = APP.indexOf('const byKey = (key)');
  assert.notEqual(at, -1, 'byKey has been renamed — this check has gone stale');
  assert.match(APP.slice(at, at + 700), /startsWith\('jira:'\)/);
});

await check('and the cancelled ones ride their own payload field, counted by nothing', () => {
  assert.match(APP, /state\.cancelledTickets = data\.cancelledTickets/, 'the field is never adopted');
  const rows = lift('const jiraRows = ()');
  assert.doesNotMatch(rows, /cancelledTickets\b(?!\.has)/, 'a cancelled ticket is being counted as a row');
});

await check('the detail is fetched once per card and never on the poll', () => {
  const fn = lift('async function ensureTicketDetail(row)');
  assert.match(fn, /state\.ticketDetail\.has\(row\.key\)/, 'a parked phone would issue a JIRA read every poll');
  assert.match(fn, /\/api\/jira\/ticket\?/);
  assert.match(fn, /epic=/, 'without the epic the server pays a bd list --all for what the row already had');
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
