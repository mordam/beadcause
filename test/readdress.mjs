#!/usr/bin/env node
//
// Handing a question to somebody else, from the phone.
//
//   npm test                     (runs it alongside the rest)
//   node test/readdress.mjs
//
// bc-jg0w. `for:<handle>` decides whose phone rings (lib/addressee.js), and until this
// it was written at exactly one moment — the moment the question was filed, from a
// terminal. The case that wants it changed is the ordinary one: a question lands on your
// phone, you read it, and it is really Carol's.
//
// Five properties, in the order they would break in:
//
// 1. **Handing it over replaces, and takes every other addressee with it.** "It is
//    really Carol's" means Carol, not Carol as well as you. Leaving the old label on
//    would leave the question ringing the phone that just handed it away, which is the
//    whole of what the tap was for.
// 2. **Empty means everyone, and that is a decision.** `for:` is what makes a question
//    quiet on five Macs out of six, so taking the labels off is the act that puts it in
//    front of whoever is free — not the absence of an act.
// 3. **The ✎ cannot strip it.** An adjust expresses a label removal as "what the card no
//    longer shows", and no card offers you to type a `for:` label. Without the guard,
//    fixing a question's title from the phone would silently start ringing five phones.
// 4. **Handing it away clears the notification, on exactly one condition.** Only when
//    the question is now addressed somewhere that is not this Mac — re-addressing it to
//    yourself, or to everyone, leaves the shade alone, because under both of those the
//    phone is still being asked. And only when this daemon actually made the noise.
// 5. **The other phone starts being asked.** The half that is not in the route at all:
//    each daemon marks every live question notified at the end of every sweep, so
//    Carol's Mac would never look at this bead again. It is the real poller here, for
//    test/ringing.mjs's reason — the rule is three lines in the middle of the push path
//    and losing it fails silently, as a phone that simply never rings.
//
// The route runs against a real server and a fake `bd`, because the two halves that can
// silently disagree — what the labels say and what the shade does — are exactly the ones
// a unit test of either would miss.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-readdress-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { ADDRESSEE_PREFIX, addresseeUpdate, addresseesOf, isAddresseeLabel } = await import(LIB('addressee.js'));
const { isProtectedLabel, normalizeEdits, updateFor } = await import(LIB('verdict.js'));
const { loadState, saveState } = await import(LIB('config.js'));

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (fn, name) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('re-addressing a question from the phone');

/* ------------------------------------------------------- the label arithmetic */

const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const bead = (...labels) => ({ id: 'zz-1', labels: ['human', ...labels] });

check(() => {
  const u = addresseeUpdate(bead(`${ADDRESSEE_PREFIX}${BOB}`), CAROL);
  assert.deepEqual(u.addLabels, [`${ADDRESSEE_PREFIX}${CAROL}`]);
  assert.deepEqual(u.removeLabels, [`${ADDRESSEE_PREFIX}${BOB}`]);
}, 'handing it over adds the new handle and takes the old one off');

check(() => {
  // Two machines can write two of these before either syncs (see `ownersOf` in
  // lib/ownership.js for the same shape). Somebody handing it to Carol means Carol,
  // so every loser comes off — leaving one on would leave it ringing there.
  const u = addresseeUpdate(bead(`${ADDRESSEE_PREFIX}${BOB}`, `${ADDRESSEE_PREFIX}dave@example.com`), CAROL);
  assert.deepEqual(u.addLabels, [`${ADDRESSEE_PREFIX}${CAROL}`]);
  assert.deepEqual(u.removeLabels.sort(), [`${ADDRESSEE_PREFIX}${BOB}`, `${ADDRESSEE_PREFIX}dave@example.com`].sort());
}, 'and every other addressee comes off with it, not only the ones that disagree');

check(() => {
  const u = addresseeUpdate(bead(`${ADDRESSEE_PREFIX}${CAROL}`), 'Carol@Example.COM');
  assert.deepEqual(u, { addLabels: [], removeLabels: [] });
}, 're-sending the handle it already carries is no write at all — case and all');

check(() => {
  for (const word of ['', '   ', 'everyone', 'anyone', 'ALL']) {
    const u = addresseeUpdate(bead(`${ADDRESSEE_PREFIX}${BOB}`, `${ADDRESSEE_PREFIX}everyone`), word);
    assert.deepEqual(u.addLabels, [], `${word || '(empty)'} writes no label`);
    assert.deepEqual(
      u.removeLabels.sort(),
      [`${ADDRESSEE_PREFIX}${BOB}`, `${ADDRESSEE_PREFIX}everyone`].sort(),
      `${word || '(empty)'} clears the lot`
    );
  }
}, 'empty — and every spelling of everyone — takes them all off and writes none');

check(() => {
  assert.deepEqual(addresseeUpdate(bead(), CAROL), {
    addLabels: [`${ADDRESSEE_PREFIX}${CAROL}`],
    removeLabels: [],
  });
  assert.deepEqual(addresseeUpdate(bead(), ''), { addLabels: [], removeLabels: [] });
  assert.deepEqual(addresseeUpdate(null, CAROL).removeLabels, [], 'a bead with no labels at all');
}, 'an unaddressed question can be handed over, and left alone');

check(() => {
  assert.equal(isAddresseeLabel(`${ADDRESSEE_PREFIX}${BOB}`), true);
  assert.equal(isAddresseeLabel('FOR:Bob@Example.com'), true, 'labels are matched case-insensitively');
  // The one that looks like a disagreement with `addresseesOf` and is not: this asks
  // whether the string belongs to the addressee vocabulary, and `for:everyone` does —
  // somebody wrote it on purpose, and nothing else may treat it as an ordinary label.
  assert.equal(isAddresseeLabel(`${ADDRESSEE_PREFIX}everyone`), true);
  assert.deepEqual(addresseesOf([`${ADDRESSEE_PREFIX}everyone`]), [], 'while it names nobody');
  assert.equal(isAddresseeLabel('human'), false);
  assert.equal(isAddresseeLabel('before:bob'), false);
  assert.equal(isAddresseeLabel(null), false);
}, 'a `for:` label is recognised as one, including the one that names nobody');

/* --------------------------------------------------------- the ✎ may not touch it */

check(() => {
  assert.equal(isProtectedLabel(`${ADDRESSEE_PREFIX}${BOB}`), true);
  assert.equal(isProtectedLabel(`${ADDRESSEE_PREFIX}everyone`), true);
  assert.equal(isProtectedLabel('unendorsed'), true, 'the two it always protected');
  assert.equal(isProtectedLabel('agent-filed'), true);
  assert.equal(isProtectedLabel('human'), false, 'and an ordinary label is still ordinary');
}, 'a `for:` label is protected from a verdict, like `owner:` and for a worse failure');

check(() => {
  // What an adjust from the phone actually sends: the label set the card is showing,
  // which never includes an addressee because no card offers you to type one.
  const norm = normalizeEdits({ title: 'A better title', labels: ['triage', `${ADDRESSEE_PREFIX}${BOB}`] });
  assert.deepEqual(norm.labels, ['triage'], 'the protected ones are dropped from the request');
  const issue = { id: 'zz-1', title: 'Old', labels: ['triage', `${ADDRESSEE_PREFIX}${BOB}`] };
  const { update } = updateFor(issue, norm);
  assert.deepEqual(update.removeLabels || [], [], 'so the save takes nothing off');
  assert.equal(update.title, 'A better title', 'while the edit it was actually for lands');
}, 'so fixing a question’s title from the phone cannot hand it back to everybody');

/* ------------------------------------------ the route, against a real server and a fake bd */

const WORLD = path.join(tmp, 'world.json');
const CALLS = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const world = () => JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const cmd = args.find((a) => !a.startsWith('-'));
if (cmd === 'show') {
  const w = world();
  const id = args[args.indexOf('show') + 1];
  // An ARRAY, because lib/bd.js's show() is (await json(...))[0] — a bare row here
  // reads as "no such bead" and every caller silently takes its not-found branch.
  process.stdout.write(JSON.stringify(w.issues[id] ? [w.issues[id]] : []));
  process.exit(0);
}
if (cmd === 'update') {
  const w = world();
  const id = args[args.indexOf('update') + 1];
  const row = w.issues[id];
  if (!row) { process.stderr.write('no issues found'); process.exit(1); }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-label' && !row.labels.includes(args[i + 1])) row.labels.push(args[i + 1]);
    if (args[i] === '--remove-label') row.labels = row.labels.filter((l) => l !== args[i + 1]);
  }
  fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
  process.stdout.write('{}');
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });

/** Put the bead back the way each check wants it, and forget what `bd` was asked. */
const world = (labels) => {
  fs.writeFileSync(WORLD, JSON.stringify({ issues: { 'zz-1': { id: 'zz-1', title: 'Gross or net?', priority: 2, labels } } }, null, 2));
  fs.rmSync(CALLS, { force: true });
};
const labelsNow = () => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues['zz-1'].labels;
const bdCalls = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

const { createApp, listen, startPoller } = await import(LIB('server.js'));

const serverCfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'readdress-test-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  me: BOB,
  workspaces: [{ name: 'demo', dir: wsDir }],
  spaces: [{ name: 'Work', workspaces: ['demo'] }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(serverCfg);
const servers = listen(serverCfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': serverCfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

const handTo = (to) =>
  call('/api/bead/addressee', { method: 'POST', body: JSON.stringify({ workspace: 'demo', id: 'zz-1', to }) });

const KEY = 'demo/zz-1';
/** This daemon believes it rang about the bead, and nothing else is in the shade. */
const ringing = () => saveState({ ringing: { [KEY]: { workspace: 'demo', id: 'zz-1', foundation: false, at: new Date().toISOString() } }, ringingDeclined: [] });

world(['human', `${ADDRESSEE_PREFIX}${BOB}`]);
ringing();
let from = app.bus.seq;
const handed = await handTo(CAROL);
let events = (app.bus.since(from) || []).filter((e) => e.type === 'dismissed');
check(() => {
  assert.equal(handed.status, 200);
  assert.deepEqual(handed.body.addressees, [CAROL], 'the response names who is asked now');
  assert.equal(handed.body.changed, true);
  assert.deepEqual(labelsNow().sort(), ['human', `${ADDRESSEE_PREFIX}${CAROL}`].sort(), 'and the bead says so');
  const update = bdCalls().find((a) => a.includes('update'));
  assert.ok(update, 'one bd update ran');
  assert.ok(update.includes('--add-label') && update.includes(`${ADDRESSEE_PREFIX}${CAROL}`), 'adding hers');
  assert.ok(update.includes('--remove-label') && update.includes(`${ADDRESSEE_PREFIX}${BOB}`), 'and removing his');
}, 'POST /api/bead/addressee moves the label and answers with what the bead now carries');

check(() => {
  assert.equal(handed.body.cleared, true, 'the response says the shade was cleared');
  assert.equal(events.length, 1, `one dismissed event (saw ${JSON.stringify(events)})`);
  assert.equal(events[0].key, KEY);
  assert.equal(events[0].reason, 'addressed', 'named, so a client need not infer it');
  assert.deepEqual(loadState().ringing, {}, 'and the daemon stops believing it is in the shade');
}, 'handing it away clears the notification it had already made — dismissed, not answered');

world(['human', `${ADDRESSEE_PREFIX}${CAROL}`]);
ringing();
const again = await handTo(CAROL);
check(() => {
  assert.equal(again.body.changed, false, 'nothing to do');
  assert.deepEqual(again.body.addressees, [CAROL], 'and it still says who has it');
  assert.deepEqual(bdCalls().filter((a) => a.includes('update')), [], 'no bd update at all');
  assert.equal(again.body.cleared, false);
  assert.ok(loadState().ringing[KEY], 'a no-op does not touch the shade either');
}, 're-sending the handle it already has is one bd show and no write');

world(['human', `${ADDRESSEE_PREFIX}${CAROL}`]);
ringing();
const back = await handTo(BOB);
check(() => {
  assert.deepEqual(back.body.addressees, [BOB]);
  assert.equal(back.body.cleared, false, 'it is being asked of this Mac now');
  assert.ok(loadState().ringing[KEY], 'so the row stays exactly where it is');
}, 'taking it back leaves the shade alone — the phone is still the one being asked');

world(['human', `${ADDRESSEE_PREFIX}${CAROL}`]);
ringing();
const everyone = await handTo('everyone');
check(() => {
  assert.deepEqual(everyone.body.addressees, [], 'nobody in particular');
  assert.deepEqual(labelsNow(), ['human'], 'and no label spelling it out');
  assert.equal(everyone.body.cleared, false);
  assert.ok(loadState().ringing[KEY], 'everyone includes you, so the notification stands');
}, 'handing it to everyone puts it back in front of whoever is free, and rings on');

world(['human', `${ADDRESSEE_PREFIX}${BOB}`]);
saveState({ ringing: {}, ringingDeclined: [] });
from = app.bus.seq;
const quietly = await handTo(CAROL);
events = (app.bus.since(from) || []).filter((e) => e.type === 'dismissed');
check(() => {
  assert.equal(quietly.body.cleared, false);
  assert.deepEqual(events, [], 'and no event that would cancel a row somebody else is holding');
}, 'a bead this daemon never rang about has nothing to clear');

const nonsense = await call('/api/bead/addressee', {
  method: 'POST',
  body: JSON.stringify({ workspace: 'demo', id: 'not a bead', to: CAROL }),
});
const missing = await call('/api/bead/addressee', {
  method: 'POST',
  body: JSON.stringify({ workspace: 'demo', id: 'zz-404', to: CAROL }),
});
check(() => {
  assert.equal(nonsense.status, 400, 'a malformed id');
  assert.equal(missing.status, 404, 'and one that is simply not there');
}, 'a bad id is refused rather than written');

/* --------------------------------------- and the other phone, which is a different half */
//
// The route above is the whole of the sending Mac. Nothing in it reaches Carol's, and
// her daemon has already marked this bead notified — it swept it the day it was filed
// and kept quiet because it was somebody else's. So the poller treats exactly one
// re-arrival as fresh, and this is the check that it still does.

const { createEventBus } = await import(LIB('events.js'));

const question = (addressees) => ({
  key: KEY,
  workspace: 'demo',
  space: 'Work',
  id: 'zz-1',
  title: 'Gross or net?',
  question: 'Gross or net?',
  priority: 2,
  addressees,
});

saveState({ notified: [], commentCounts: {}, ringing: {}, ringingDeclined: [], quiet: {}, filter: { space: 'all', workspace: 'all' } });

let inbox = [];
const bus = createEventBus();
const timer = startPoller(
  { ...serverCfg, pollSeconds: 1 },
  { bus, hooks: {}, bd: { comments: async () => [], removeLabel: async () => {} }, allQuestions: async () => inbox }
);

const settled = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// The first cycle is the baseline sweep and pushes nothing by design.
await settled(() => loadState().notified.length > 0 || bus.seq > 0);

// It arrives addressed to Carol, on Bob's Mac: quiet, and recorded as quiet *because*
// it was addressed elsewhere — which is the only one of the three kinds of quiet a
// label can undo.
inbox = [question([CAROL])];
const wentQuiet = await settled(() => loadState().quiet?.[KEY]?.reason === 'addressed');
check(() => {
  assert.ok(wentQuiet, 'it arrived quietly and said why');
  assert.deepEqual(loadState().ringing, {}, 'so nothing rang');
  assert.ok(loadState().notified.includes(KEY), 'and it is marked notified, which is what would bury it');
}, 'a question addressed elsewhere arrives quietly and is never looked at again');

// Somebody hands it to Bob. Nothing else about the bead moves.
inbox = [question([BOB])];
const rangUp = await settled(() => Boolean(loadState().ringing[KEY]));
clearInterval(timer);
check(() => {
  assert.ok(rangUp, 'the poller treated it as a fresh arrival and pushed it');
  assert.ok(!loadState().quiet?.[KEY], 'and the quiet record is dropped, so it cannot fire twice');
}, 'and when it is handed to this Mac, the poller rings once');

/* --------------------------------------------------- and the card, read as source */
//
// The inbox renderer needs a whole document to run (test/quietcard.mjs says why), so the
// client half is a read of the file — with the comments blanked first, because every file
// in this repo argues in prose that names its own identifiers and a grep over the block
// is routinely satisfied by the paragraph above the line it is guarding. What is asserted
// is what a refactor breaks silently: the pill is drawn on the card, the panel offers the
// two answers the acceptance names, and the class it draws has a rule to draw it with.

const { stripComments } = await import(LIB('checkaudit.js'));
const APP = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
const CSS = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'));

check(() => {
  assert.match(APP, /\$\{addresseeHtml\(q\)\}/, 'the pill is drawn in the card head');
  assert.match(APP, /\$\{addressPanelHtml\(q\)\}/, 'and the panel with it');
  assert.match(APP, /state\.me\.includes\(h\)/, 'a question addressed to this Mac reads as yours');
  assert.match(APP, /if \(Array\.isArray\(data\.me\)\) state\.me = data\.me;/, 'off the payload');
}, 'the card draws who a question is for, from the handles the daemon says it answers to');

check(() => {
  assert.match(APP, /'\/api\/bead\/addressee'/, 'the tap reaches the route');
  assert.match(APP, /JSON\.stringify\(\{ workspace: q\.workspace, id: q\.id, to \}\)/, 'with the handle');
  assert.match(APP, /q\.addressees = res\.addressees \|\| \[\];/, 'and repaints from what the bead now carries');
  // The acceptance criterion, in the two words it is written in: to somebody else, and
  // to everybody. The second is the button that would quietly not get built.
  assert.match(APP, /btn\('everyone', /, 'everyone is a button, not the absence of one');
}, 'and posts the hand-off, then believes the server rather than the tap');

check(() => {
  for (const cls of ['.pill.for', '.address-panel', '.address-row', '.address-btn', '.address-typed', '.address-say']) {
    assert.ok(CSS.includes(`${cls} `) || CSS.includes(`${cls},`) || CSS.includes(`${cls}{`), `${cls} has a rule`);
  }
  // Drawn by app.js and styled by style.css, which is the mixed pair the service worker
  // version exists for — docs/sw-cache/v54.md.
  for (const cls of ['address-panel', 'address-row', 'address-btn', 'address-typed', 'address-say']) {
    assert.ok(APP.includes(`"${cls}`) || APP.includes(`${cls}"`), `${cls} is drawn`);
  }
}, 'every class the panel draws has a rule in the stylesheet that ships with it');

/* ------------------------------------------------------------------------ done */

for (const s of servers) s.close();
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} checks failed\x1b[0m` : `\n\x1b[32mall ${ran} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
