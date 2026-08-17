#!/usr/bin/env node
/**
 * Answering a delivery card with **Request changes** — against a bd that refuses. bc-36xx.17.
 *
 *     npm test
 *     node test/handbackdelivery.mjs
 *
 * The two answers that end an attempt without ending the work — `CHANGES:` and `DECLINE:`
 * — both put the work bead back in the queue, and both used to do it with `Bd.reopen`.
 * That call is refused outright by bd 1.2.1 whenever the assignee is not the actor, and on
 * this path that is not an edge case, it is **every time**: since bc-r941 a worker delivers
 * and stops, so the claim is held by a window the daemon reaped hours before Adam taps
 * anything. The bead stayed `in_progress` and assigned, which is out of `bd ready` for
 * good; the delivery card had already closed as answered and nothing re-raises one. So the
 * pull request sat open with a change requested and nothing anywhere was coming back for
 * it — bc-36xx.10 on #401 for two hours on 2026-08-17, found by accident.
 *
 * And the reason it cost two hours rather than one grep: the log line one below the
 * refusal said `changes requested on #401 — bc-36xx.10 back in the queue`, unconditionally,
 * after a call whose result nothing looked at.
 *
 * test/reassignguard.mjs owns the guard itself and the argv `reopenAbandoned` builds. What
 * is asserted **here** is the thing a stub of `bd` can never show: the whole answer driven
 * through the real `/api/respond`, against a fake bd binary that *enforces* the refusal the
 * way the real one does, ending with the bead's row read back —
 *
 *   - a bead claimed by a window that is gone comes back **open, unassigned and in
 *     `bd ready`**, on both answers;
 *   - a claim that is genuinely live is still handed back without `--force` ever being
 *     asked for, so the guard keeps doing its job where it was added to;
 *   - and when the hand-back cannot be made at all, the log line and the card **say so**
 *     rather than announcing the queue.
 *
 * The fake bd is deliberately stateful, unlike the one in test/attribution.mjs: the claim
 * this is about only exists as a row that a write does or does not change, and a fake that
 * merely records argv would pass with the bug still in.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-handbackdelivery-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

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
    bad(name, String(err && err.message ? err.message : err).split('\n')[0]);
  }
};

/* ---------------------------------------------------------- a bd that says no */

/**
 * One row, one log of writes, and the refusal verbatim.
 *
 * The sentence is copied out of ~/Library/Logs/beadcause.log for 2026-08-17 — the same one
 * test/reassignguard.mjs cuts `REASSIGN_GUARD_RE` from — because a fake that refuses in its
 * own words would prove only that this code handles a refusal it invented.
 */
const STATE = path.join(tmp, 'bead.json');
const CALLS = path.join(tmp, 'calls.log');
const FAKE = path.join(tmp, 'bd');
const HOLDER = 'neadamthal@gmail.com';
const DAEMON = 'beadcause-test';
const WORK = 'zz-work';

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const S = ${JSON.stringify(STATE)};
const state = JSON.parse(fs.readFileSync(S, 'utf8'));
const save = () => fs.writeFileSync(S, JSON.stringify(state));
const out = (s) => { process.stdout.write(s); process.exit(0); };

const work = () => ({
  id: ${JSON.stringify(WORK)}, issue_type: 'task', title: 'The work itself', comment_count: 0,
  priority: 1, labels: [], description: 'Something small.', dependencies: [],
  status: state.status, assignee: state.assignee || '',
});
const card = () => ({
  id: 'zz-pr', issue_type: 'task', status: 'open', title: 'A delivery', comment_count: 1,
  priority: 1, labels: ['human'], description: state.body, dependencies: [],
});

if (args[0] === 'show') out(JSON.stringify([args[1] === ${JSON.stringify(WORK)} ? work() : card()]));
if (args[0] === 'comments') out('[]');
// What \`bd ready\` actually filters on, and the only half of it this file needs: a bead
// that is claimed is not in it, whatever its status says.
if (args[0] === 'ready') out(JSON.stringify(state.status === 'open' && !state.assignee ? [work()] : []));

if (args[0] === 'update' && args[1] === ${JSON.stringify(WORK)}) {
  const at = args.indexOf('--actor');
  const actor = at === -1 ? '' : args[at + 1];
  const forced = args.includes('--force');
  const clearing = args.includes('--assignee') && !args[args.indexOf('--assignee') + 1];
  if (clearing && state.assignee && state.assignee !== actor && !forced) {
    process.stderr.write(
      'cannot reassign ' + ${JSON.stringify(WORK)} + ': held by "' + state.assignee + '" (in_progress); coordinate with the ' +
      'holder (bd mail ' + state.assignee + ') — pass --force only if their claim is abandoned (crashed ' +
      'agent, expired lease), or use bd reclaim\\n'
    );
    process.exit(1);
  }
  if (state.refuse) { process.stderr.write(state.refuse + '\\n'); process.exit(1); }
  const st = args.indexOf('--status');
  if (st !== -1) state.status = args[st + 1];
  if (clearing) state.assignee = '';
  save();
  out('updated\\n');
}
out('[]');
`,
  { mode: 0o755 }
);

const calls = () =>
  fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
/** Every write aimed at the work bead — the hand-back and nothing else. */
const handBacks = () => calls().filter((c) => c[0] === 'update' && c[1] === WORK);
/**
 * Everything bd was told, as one string.
 *
 * What the *card* says is not in the HTTP response body: `delivered.note` is folded into
 * the answer `Bd.respond` comments onto the delivery question, which is where the phone
 * reads it back from. So the assertion has to be made against the argv, which is where the
 * sentence actually ends up.
 */
const wrote = () => calls().map((c) => c.join(' ')).join('\n');
const row = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));

/* ------------------------------------------------------------------ fake gh */

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const PR_STATE = path.join(tmp, 'pr.json');
fs.writeFileSync(
  PR_STATE,
  JSON.stringify({
    number: 7,
    title: 'Something small',
    url: 'https://github.com/acme/widgets/pull/7',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    headRefName: 'bead/zz-work',
    baseRefName: 'main',
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    statusCheckRollup: [],
    reviewDecision: null,
    mergedAt: null,
    mergeCommit: null,
  })
);
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth') out('Logged in to github.com\\n');
if (args[0] === 'pr') {
  if (args[1] === 'view') out(fs.readFileSync(${JSON.stringify(PR_STATE)}, 'utf8'));
  if (args[1] === 'close' || args[1] === 'comment') out('done\\n');
}
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));
const { deliveryBody, CHANGES_MARKER, DECLINE_MARKER } = await import(LIB('delivery.js'));

const DELIVERY = {
  workspace: 'demo',
  bead: WORK,
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  branch: 'bead/zz-work',
  base: 'main',
  method: 'squash',
  summary: 'Something small.',
};
const BODY = deliveryBody(DELIVERY);

const port = await freePort();
const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  port,
  token: 'handback-token',
  actor: DAEMON,
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: ws }],
  sessionDirs: { demo: ws },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};
listen(cfg, createApp(cfg).handler);

const post = (pathname, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
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
const TOKEN = { 'x-beadcause-token': cfg.token };

const up = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      await post('/api/nothing', {});
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
};
await up();

/**
 * A delivery answered by a person, hours after the worker that made it went away — with
 * the log captured, because half of what this bead was about is what the daemon *says*.
 */
async function answer(response, { assignee = HOLDER, status = 'in_progress', refuse = null } = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ status, assignee, refuse, body: BODY }));
  fs.writeFileSync(CALLS, '');
  const said = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => said.push(a.join(' '));
  console.error = (...a) => said.push(a.join(' '));
  try {
    const r = await post('/api/respond', { workspace: 'demo', id: 'zz-pr', response }, TOKEN);
    return { r, said: said.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

/** Is the bead in `bd ready` — asked of the fake exactly as the advocate would ask it. */
const inReady = () => spawnSync(FAKE, ['ready', '--json'], { encoding: 'utf8' }).stdout.trim() !== '[]';

console.log('\na changes-requested answer, against a bd that refuses the hand-back\n');

/* ----------------------------------------- the bug: a claim whose holder is gone */

{
  const { r, said } = await answer(`${CHANGES_MARKER} the second helper is doing two things`);
  check(() => assert.equal(r.status, 200), 'the answer lands');
  check(
    () => assert.deepEqual(handBacks().map((c) => c.includes('--force')), [false, true]),
    'the plain hand-back is tried first and the refusal is what escalates — never `--force` on spec'
  );
  const after = row();
  check(() => assert.equal(after.status, 'open'), 'the bead is open again');
  check(() => assert.equal(after.assignee, ''), 'and unassigned — both halves, or `bd ready` still skips it');
  check(() => assert.ok(inReady()), 'so a queue can see it: this is the whole of what was broken');
  check(
    () => assert.match(said, /changes requested on #7 — zz-work is back in the queue/),
    'and the log says it, having this time looked'
  );
  check(() => assert.match(wrote(), /is back in the queue/), 'and so does the answer written onto the card');
  check(() => assert.equal(r.json.delivery?.handedBack, true), 'and the response carries it, for anything watching');
}

/* ------------------------------------------------ the same, on the other answer */

{
  const { r, said } = await answer(`${DECLINE_MARKER} start from the router instead`);
  check(() => assert.equal(r.status, 200), 'a decline lands too');
  const after = row();
  check(
    () => assert.equal(`${after.status}/${after.assignee}`, 'open/'),
    'and it hands the bead back over the same guard — the branch is abandoned, the work is not'
  );
  check(() => assert.match(said, /declined #7 with direction — zz-work is back in the queue/), 'said out loud');
}

/* --------------------------------------- the guard still guards where it belongs */

{
  // The claim is the daemon's own — which is what `bd` sees when nothing else holds it.
  // `reopenAbandoned` is not a louder `reopen`: on the ordinary case it makes exactly the
  // write it always made, and a live claim held by somebody still typing is refused as
  // loudly as ever on the paths that still call `reopen` (test/reassignguard.mjs).
  const { r } = await answer(`${CHANGES_MARKER} one more thing`, { assignee: DAEMON });
  check(() => assert.equal(r.status, 200), 'an unrefused hand-back still works');
  check(
    () => assert.deepEqual(handBacks().map((c) => c.includes('--force')), [false]),
    'one write, unforced — nothing is stepped over that did not refuse'
  );
  check(() => assert.equal(row().status, 'open'), 'and the bead comes back');
}

/* --------------------------------------------- a hand-back that cannot be made */

{
  // A refusal that is *not* the guard — a lock, a vanished bead — must come back as
  // itself. The old code caught every error into one line and then announced the queue
  // regardless, which is why two hours went on hunting a bead that had quietly stopped
  // existing rather than one grep of the log.
  const { r, said } = await answer(`${CHANGES_MARKER} and again`, {
    assignee: '',
    refuse: 'dolt: database is locked',
  });
  check(() => assert.equal(r.status, 200), 'the answer still lands — the comment on the PR is not undone by this');
  check(
    () => assert.match(said, /could NOT be handed back and is still claimed — .*database is locked/),
    'the log reports what happened, rather than asserting what was attempted'
  );
  check(
    () => assert.doesNotMatch(said, /zz-work is back in the queue/),
    'and does not say the opposite in the same breath'
  );
  check(
    () => assert.match(wrote(), /could \*\*not\*\* be put back in the queue/),
    'the card says it too — the only person who can release it by hand is the one reading it'
  );
  check(() => assert.equal(r.json.delivery?.handedBack, false), 'and the response carries it, for anything watching');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
