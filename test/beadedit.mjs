#!/usr/bin/env node
/**
 * Editing a bead that already exists — the sheet's ✎, which is not a verdict.
 *
 *     npm test
 *     node test/beadedit.mjs
 *
 * test/verdicts.mjs proves the other door: `POST /api/bead/adjust` rewrites the same six
 * fields and **refuses any bead that has been endorsed**, because it is a verdict on a
 * proposal and a queue row goes stale under a thumb. This file proves the half that
 * refusal was never about — the detail sheet, open on one bead, where the endorsement
 * state of that bead is not a reason to say no.
 *
 * What is asserted, and why each is here rather than assumed:
 *
 * 1. **An endorsed, open bead is editable.** This is the whole bead, and it is the exact
 *    call `/api/bead/adjust` answers 409 to — so both are made, against the same bead in
 *    the same state, in one check. A regression that let the guard leak across would
 *    otherwise look like a working route.
 * 2. **The two protections that are not about endorsement survive.** `unendorsed` and
 *    `agent-filed` cannot be set or cleared, and `owner:` cannot be moved — asserted on
 *    the argv the stub `bd` logs, because the failure mode is a `--set-labels` that wipes
 *    them as collateral and only the flags can show it. `for:`, `ran:` and `filed-while:`
 *    ride the same predicate and one of them is checked to prove the import is live.
 * 3. **A closed bead is refused.** Its description is the record of what was done.
 * 4. **A bead a session is working is edited, and the thread says so.** The open question
 *    the bead was filed with, decided in lib/beadedit.js — so the assertion is on the
 *    comment, which is the whole of what makes the decision safe.
 * 5. **A form that posts what the bead already says writes nothing**, which is the
 *    ordinary case for a sheet that saves on every field and the reason `changed` is a
 *    flag rather than an error.
 * 6. **The verdict path is untouched.** `/api/bead/adjust` still refuses an endorsed bead
 *    and still writes its own wording on the thread.
 *
 * Same shape as test/verdicts.mjs and deliberately its own file: `bd` is a stub binary
 * over a JSON file that logs its argv, and the route is exercised over a real socket
 * against `createApp`, because the guards live at the door and a unit call would skip
 * every one of them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-beadedit-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { FILED_LABEL } = await import(LIB('filing.js'));
const { ADJUSTED_PREFIX, changeSummary, updateFor, normalizeEdits } = await import(LIB('verdict.js'));
const { editBead, editRefusal, isInProgress, EDIT_PREFIX, IN_PROGRESS_NOTE } = await import(LIB('beadedit.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads and writes it.
 *
 * `update` is implemented flag by flag — `--add-label` / `--remove-label` as repeatable
 * strings — because several assertions below are about *which* flags the edit reached
 * for. A stub that applied a patch would pass whatever the code did, including a
 * `--set-labels` that took the hold and the owner off as collateral.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify(args) + '\\n');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const one = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  if (args.includes('--set-labels')) die('an edit must never replace a bead\\'s labels wholesale');
  const set = (flag, field) => { const v = one(flag); if (v !== null) issue[field] = v; };
  set('--title', 'title');
  set('--type', 'issue_type');
  set('--description', 'description');
  set('--acceptance', 'acceptance_criteria');
  set('--notes', 'notes');
  const p = one('--priority');
  if (p !== null) issue.priority = Number(String(p).replace(/^p/i, ''));
  issue.labels = issue.labels || [];
  for (const l of many('--add-label')) if (!issue.labels.includes(l)) issue.labels.push(l);
  const off = many('--remove-label');
  if (off.length) issue.labels = issue.labels.filter((l) => !off.includes(l));
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.comments = issue.comments || [];
  issue.comments.push({ text: args[2], actor: one('--actor') || '' });
  save();
  process.exit(0);
}
if (args[0] === 'comments') {
  const issue = w.issues[args[1]];
  process.stdout.write(JSON.stringify((issue && issue.comments) || []));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: 'as it stands',
  acceptance_criteria: 'the way bd names it, which is not the way an edit does',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  ...extra,
});

/**
 * Four beads: ordinary endorsed work, one still held, one being worked, one closed.
 *
 * `zz-live` carries an `owner:` and a `for:` on purpose — those two are the protections
 * that would be lost by *omission* rather than by a wrong write, so the fixture has to
 * carry them before the save that does not mention them.
 */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-live': issue('zz-live', { labels: ['api', 'owner:adam', 'for:carol', 'ran:opus'] }),
          'zz-held': issue('zz-held', { labels: [UNENDORSED, FILED_LABEL, 'api'] }),
          'zz-busy': issue('zz-busy', { status: 'in_progress', assignee: 'beadcause', labels: ['api'] }),
          'zz-done': issue('zz-done', { status: 'closed', close_reason: 'landed as #1' }),
        },
      },
      null,
      2
    )
  );
  clearCalls();
};
reset();

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8')).issues;
const beadAt = (id) => world()[id];
const labelsOf = (id) => beadAt(id).labels;
const threadOf = (id) => (beadAt(id).comments || []).map((c) => c.text);

/* --------------------------------------------------------------------- harness */

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

console.log('\nthe bead sheet’s ✎ — any open bead, endorsed or not\n');

/* ----------------------------------------------------------------- the unit half */

await check('a closed bead is the one status refused, and the refusal says why', () => {
  assert.equal(editRefusal(issue('zz-x')), null, 'an open bead is editable');
  assert.equal(editRefusal(issue('zz-x', { status: 'in_progress' })), null, 'and so is one being worked');
  const no = editRefusal(issue('zz-x', { status: 'closed' }));
  assert.equal(no?.status, 409, 'a closed bead is refused');
  assert.match(String(no.message), /record of what was done/, 'and the message says what to do instead');
});

await check('the two wordings on the thread cannot drift into each other', () => {
  const bead = beadAt('zz-live');
  const { update } = updateFor(bead, normalizeEdits({ title: 'A better title' }));
  assert.equal(
    changeSummary(bead, update),
    `${ADJUSTED_PREFIX} title (was “${bead.title}”).`,
    'the verdict path reads exactly as it did'
  );
  assert.equal(
    changeSummary(bead, update, EDIT_PREFIX),
    `${EDIT_PREFIX} title (was “${bead.title}”).`,
    'and an edit says the true thing about a bead endorsed weeks ago'
  );
  assert.notEqual(EDIT_PREFIX, ADJUSTED_PREFIX, 'two acts, two words, greppable apart');
});

await check('isInProgress reads bd’s own word for a claimed bead', () => {
  assert.equal(isInProgress({ status: 'in_progress' }), true);
  assert.equal(isInProgress({ status: 'IN_PROGRESS' }), true, 'and does not care how bd cases it');
  assert.equal(isInProgress({ status: 'open' }), false);
  assert.equal(isInProgress({}), false);
});

await check('editing writes the fields, the thread line, and nothing else', async () => {
  reset();
  const out = await editBead(bd, ws, 'zz-live', { edits: { title: 'Renamed', priority: 'P1' }, actor: 'adam' });
  assert.equal(out.changed, true);
  assert.deepEqual(out.fields.sort(), ['priority', 'title']);
  assert.equal(beadAt('zz-live').title, 'Renamed');
  assert.equal(beadAt('zz-live').priority, 1);
  assert.equal(threadOf('zz-live').length, 1, 'one line saying what moved');
  assert.match(threadOf('zz-live')[0], new RegExp(EDIT_PREFIX.replace(/[_:]/g, '\\$&')));
  assert.ok(!threadOf('zz-live')[0].includes(IN_PROGRESS_NOTE), 'and no clause about a session that is not there');
});

/* --------------------------------------------------------------- the HTTP half */

const { createApp, listen } = await import(LIB('server.js'));

const cfg = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: '',
  token: 'beadedit-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [ws],
  sessionDirs: { demo: path.join(tmp, 'no-such-checkout') },
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
// createApp and listen hold this object by reference, so the two fields that could only
// be known once the kernel had chosen are filled in here, before the first call.
cfg.port = port;
cfg.baseUrl = `http://127.0.0.1:${port}`;

const post = (pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-beadcause-token': cfg.token,
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
    req.write(payload);
    req.end();
  });

await check('POST /api/bead/edit rewrites an endorsed bead that /api/bead/adjust refuses', async () => {
  reset();
  // The same bead, in the same state, through both doors — because a guard leaking from
  // one to the other is exactly the regression this bead exists to prevent, and either
  // call passing alone would look like a working route.
  const refused = await post('/api/bead/adjust', { workspace: 'demo', id: 'zz-live', edits: { title: 'via adjust' } });
  assert.equal(refused.status, 409, `adjust must still refuse an endorsed bead: ${JSON.stringify(refused.json)}`);
  assert.equal(beadAt('zz-live').title, 'bead zz-live', 'and write nothing on the way to the refusal');

  const res = await post('/api/bead/edit', {
    workspace: 'demo',
    id: 'zz-live',
    edits: {
      title: 'Renamed from the sheet',
      type: 'bug',
      priority: 'P1',
      description: 'what it really is',
      acceptance: 'how we would know',
      labels: ['api', 'triage'],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.changed, true);
  const bead = beadAt('zz-live');
  assert.equal(bead.title, 'Renamed from the sheet');
  assert.equal(bead.issue_type, 'bug');
  assert.equal(bead.priority, 1);
  assert.equal(bead.description, 'what it really is');
  assert.equal(bead.acceptance_criteria, 'how we would know');
  assert.ok(bead.labels.includes('triage'), 'a label you typed is added');
  assert.deepEqual(res.json.fields.sort(), ['acceptance', 'description', 'labels', 'priority', 'title', 'type']);
});

await check('and it cannot lose the owner, the addressee or the marker by omission', async () => {
  reset();
  // The save posts the label set the card is showing — which is every ordinary label and
  // none of the protected prefixes, because no card offers you to type one.
  const res = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-live', edits: { labels: ['api'] } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const labels = labelsOf('zz-live');
  assert.ok(labels.includes('owner:adam'), `owner: moves through /api/bead/owner and nowhere else: ${labels}`);
  assert.ok(labels.includes('for:carol'), `for: moves through /api/bead/addressee: ${labels}`);
  assert.ok(labels.includes('ran:opus'), `ran: is a record and there is no route that sets it: ${labels}`);
  const removed = bdCalls()
    .filter((a) => a[0] === 'update')
    .flatMap((a) => a.filter((_, i) => a[i - 1] === '--remove-label'));
  assert.deepEqual(removed, [], `nothing was taken off at all here: ${removed.join(', ')}`);
  assert.ok(!bdCalls().some((a) => a.includes('--set-labels')), 'and never wholesale');
});

await check('an unendorsed bead is editable here too, and stays held', async () => {
  reset();
  const res = await post('/api/bead/edit', {
    workspace: 'demo',
    id: 'zz-held',
    edits: { title: 'Fixed the typo', labels: ['api'] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(beadAt('zz-held').title, 'Fixed the typo');
  assert.ok(labelsOf('zz-held').includes(UNENDORSED), 'fixing a title is not agreeing to the work');
  assert.ok(labelsOf('zz-held').includes(FILED_LABEL), 'and provenance is not yours to drop');
  // What the route needs it for: a held bead's title is what the endorsement queue draws,
  // and that list is cached — so the save has to say the row it just rewrote is in it.
  assert.equal(res.json.held, true, 'so the queue cache can be dropped for exactly this case');
  const live = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-live', edits: { title: 'not in that list' } });
  assert.equal(live.json.held, false, 'and left alone for a bead no queue is drawing');
});

await check('a bead a session is working is edited, and the thread says a session was on it', async () => {
  reset();
  const res = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-busy', edits: { priority: 'P0' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.inProgress, true, 'so a client can say so out loud');
  assert.equal(beadAt('zz-busy').priority, 0, 'refusing would mean it could never be fixed — in_progress goes to closed');
  const line = threadOf('zz-busy')[0] || '';
  assert.ok(line.includes(IN_PROGRESS_NOTE), `the next reader of the thread has to know: ${line}`);
});

await check('a closed bead is 409 and nothing is written', async () => {
  reset();
  const res = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-done', edits: { title: 'rewriting history' } });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.equal(beadAt('zz-done').title, 'bead zz-done');
  assert.ok(!bdCalls().some((a) => a[0] === 'update'), 'and no write was attempted');
});

await check('a form posted unchanged is a 200 that touched nothing', async () => {
  reset();
  const bead = beadAt('zz-live');
  const res = await post('/api/bead/edit', {
    workspace: 'demo',
    id: 'zz-live',
    edits: {
      title: bead.title,
      type: bead.issue_type,
      priority: bead.priority,
      description: bead.description,
      acceptance: bead.acceptance_criteria,
      // The protected prefixes are not on the card, so they are not in what it posts.
      labels: ['api'],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.changed, false, 'which is the ordinary answer for a sheet that saves on every field');
  assert.deepEqual(res.json.fields, []);
  assert.ok(!bdCalls().some((a) => a[0] === 'update'), 'no bd write at all');
  assert.deepEqual(threadOf('zz-live'), [], 'and nothing on the thread to bury the real changes under');
});

await check('the refusals a client can be wrong in', async () => {
  reset();
  const nobody = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-nope', edits: { title: 'x' } });
  assert.equal(nobody.status, 404, `an id that is gone is a thing you tapped: ${JSON.stringify(nobody.json)}`);

  const junk = await post('/api/bead/edit', { workspace: 'demo', id: '../../etc/passwd', edits: { title: 'x' } });
  assert.equal(junk.status, 400, JSON.stringify(junk.json));

  const nothing = await post('/api/bead/edit', { workspace: 'demo', id: 'zz-live', edits: { notes: 'not editable' } });
  assert.equal(nothing.status, 400, 'notes and deps are the filing agent’s provenance, not a field of this form');

  const nowhere = await post('/api/bead/edit', { workspace: 'not-a-workspace', id: 'zz-live', edits: { title: 'x' } });
  assert.equal(nowhere.status, 400, JSON.stringify(nowhere.json));
});

await check('and the verdict path still writes its own wording, not this one', async () => {
  reset();
  const res = await post('/api/bead/adjust', { workspace: 'demo', id: 'zz-held', edits: { title: 'via adjust' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const line = threadOf('zz-held')[0] || '';
  assert.ok(line.startsWith(ADJUSTED_PREFIX), `an adjust is still an adjust: ${line}`);
  assert.ok(labelsOf('zz-held').includes(UNENDORSED), 'and it still keeps the marker');
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
for (const s of servers || []) s.close?.();
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
