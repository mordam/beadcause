#!/usr/bin/env node
/**
 * **Answering a sweep card's hand-back** — the far end of the conflict loop (bc-9d37.8).
 *
 *     npm test
 *     node test/sweepanswer.mjs
 *
 * lib/sweepcard.js files one card per conflict sweep, and when a resolver stops without
 * making its branch mergeable it names the pull request and quotes what the session said.
 * Until this the card could not act on the answer: its decision block had one option,
 * **Noted**, which closed it. So Adam read "both sides rewrote renderRow and only you can
 * say which wins", typed which one wins, and *nothing read it* — the next step was a Mac,
 * a branch, and *Resolve conflicts*, which opens a session with the ordinary brief knowing
 * nothing about the decision he had just made.
 *
 * test/sweepcard.mjs owns the card's own half — the options it emits, and `sweepAnswer`
 * turning a tap or a sentence back into "this pull request, that instruction". What only a
 * real server can answer is what the *handler* does with it, and three of those claims are
 * ones a grep for the call would pass while the feature was broken:
 *
 * 1. **The card must not close.** It amends itself as the row it just restarted finishes
 *    and closes itself when everything comes back mergeable, so an answer that starts that
 *    again has to be a commission — including the bare-sentence path, which names no
 *    option and would otherwise take the ordinary closing route.
 * 2. **A refusal has to be said, and has to leave the card there.** A window macOS will
 *    not open, or a daemon with windows switched off, must leave the question answerable
 *    rather than closed over a promise nothing kept — the rule the three answers beside
 *    this one already keep.
 * 3. **Every other question in the inbox is untouched.** This runs on every `/api/respond`
 *    and most of them are about nothing of the sort.
 *
 * The server is real (`createApp` + `listen`), `bd` is a fake binary with a JSON world
 * behind it, and no window is ever opened: `openSessions: false` is the last refusal
 * before the launch, so the answer travels the whole path and stops one line short of
 * iTerm. What the brief a window *would* carry says is asserted off `conflictPromptFor` in
 * test/prfull.mjs, for the reason that file gives — nothing in this repo's tests may
 * launch iTerm.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sweepanswer-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the sweep records live under it.
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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const { SWEEP_CARDS_PATH, readSweepCards, sweepCardBody, sweepCardTitle } = await import(LIB('sweepcard.js'));

/* ---------------------------------------------------------------- the fake bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const WORLD = ${JSON.stringify(WORLD)};
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const save = () => fs.writeFileSync(WORLD, JSON.stringify(w, null, 2));
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([{ ...issue, dependencies: [] }]));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'close') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  issue.status = 'closed';
  issue.close_reason = flag('--reason') || '';
  save();
  process.exit(0);
}
if (args[0] === 'comment') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  (issue.comments = issue.comments || []).push(args[2]);
  save();
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const status = flag('--status');
  if (status) issue.status = status;
  const desc = flag('--description');
  if (desc !== null) issue.description = desc;
  save();
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'remove') {
  const issue = w.issues[args[2]];
  if (issue) issue.labels = (issue.labels || []).filter((l) => l !== args[3]);
  save();
  process.exit(0);
}
// Everything else — the label reads, the dep walks, the lists — answers "nothing", which
// is what it is: this world has one card and one ordinary question in it.
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/* ---------------------------------------------------------------- the fake gh */

/**
 * Only ever asked one thing: is this still conflicting? A row that stopped moving is the
 * last thing the follow-up will ever see of it, so the answer here has to come from GitHub
 * and not from the card — a branch somebody rebased by hand yesterday still reads
 * `handed-back` on it.
 */
const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH_STATE = path.join(tmp, 'gh.json');
const gh = (over) => fs.writeFileSync(GH_STATE, JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING', ...over }));
gh({});

fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { process.stdout.write('Logged in to github.com\\n'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') {
  const s = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, 'utf8'));
  process.stdout.write(JSON.stringify({
    number: Number(args[2]) || 11,
    title: 'Thing',
    url: 'https://github.com/acme/widgets/pull/' + (args[2] || 11),
    isDraft: false,
    mergeStateStatus: 'DIRTY',
    headRefName: 'worktree-thing-11',
    baseRefName: 'main',
    statusCheckRollup: [],
    reviewDecision: null,
    mergedAt: null,
    mergeCommit: null,
    ...s,
  }));
  process.exit(0);
}
process.stdout.write('{}');
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

/* ------------------------------------------------------------------ the world */

const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsDir, '.beads'), { recursive: true });
const checkout = path.join(tmp, 'checkout');
fs.mkdirSync(checkout, { recursive: true });

/** The record lib/sweepcard.js keeps, as it looks once the resolvers have all stopped. */
const record = (prs) => ({
  card: 'bc-card',
  workspace: 'demo',
  key: 'demo',
  dir: checkout,
  repo: 'acme/widgets',
  after: 231,
  base: 'main',
  at: new Date().toISOString(),
  prs,
});

const handed = (number, over = {}) => ({
  number,
  branch: `worktree-thing-${number}`,
  title: `Thing ${number}`,
  url: `https://github.com/acme/widgets/pull/${number}`,
  beads: [`bc-${number}`],
  state: 'handed-back',
  note: '',
  said: 'both sides rewrote renderRow',
  ...over,
});

/** The tracker and the record together, as one sweep leaves them. */
function reset(prs) {
  const rec = record(prs);
  fs.writeFileSync(SWEEP_CARDS_PATH, JSON.stringify({ 'bc-card': rec }, null, 2));
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'bc-card': {
            id: 'bc-card',
            title: sweepCardTitle(rec),
            description: sweepCardBody(rec),
            labels: ['human'],
            status: 'open',
            issue_type: 'task',
            dependencies: [],
            comments: [],
          },
          'bc-ask': {
            id: 'bc-ask',
            title: 'An ordinary question',
            description: 'Which of these two?',
            labels: ['human'],
            status: 'open',
            issue_type: 'task',
            dependencies: [],
            comments: [],
          },
        },
      },
      null,
      2
    )
  );
  return rec;
}

/* ------------------------------------------------------------------ the daemon */

const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  port: 0,
  token: 'sweepanswer-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [{ name: 'demo', dir: wsDir }],
  sessionDirs: { demo: checkout },
  // The last refusal before the launch. Every line of the path up to it runs for real.
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

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

const card = () => world().issues['bc-card'];
const thread = () => (card().comments || []).join('\n');

/* ----------------------------------------------------- one branch, no button needed */

console.log('\na card with one branch waiting takes a bare sentence');

reset([handed(11)]);
let res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'take main’s renderRow' });
check('the answer is accepted', res.status === 200, JSON.stringify(res.json));
/**
 * The claim the whole feature rests on. A bare sentence names no option, so `chosenOption`
 * has nothing to read `closes: false` off — and without `resolveSweepFor` deciding it
 * first, this answer would take the ordinary route and close the card that is meant to
 * report what happens next.
 */
check('the card stays open — this answer starts work rather than settling it', card().status === 'open', card().status);
check('and it says why, on the thread', /Left open/.test(thread()), thread());
check('what he said is on the thread verbatim', /take main’s renderRow/.test(thread()), thread());
// Windows are off in this daemon, which is the one refusal short of iTerm.
check('the refusal names the pull request rather than failing silently', /Nothing opened for #11/.test(thread()), thread());
check('and says which of the reasons it was', /openSessions/.test(thread()), thread());
check('nothing was opened, so the row is still waiting on him', readSweepCards()['bc-card'].prs[0].state === 'handed-back');
check('and the record is still there to answer into', Object.keys(readSweepCards()).length === 1);
/**
 * The half a commission would otherwise get wrong. `bd.commission` takes `human` off, and
 * that one label is *both* "in the inbox" and "not in an advocate's ready queue" — so
 * without `stayInInbox` this answer would take the card off the phone while it was still
 * the only thing reporting the window it started, and hand a summary of a sweep to the
 * next advocate tick as work to open a session on.
 */
check('and the card is still in the inbox', (card().labels || []).includes('human'), JSON.stringify(card().labels));
check('with what it did said as an instruction, not as work handed back', /reports how it goes/.test(thread()), thread());

/* ------------------------------------------------------------- Noted still closes */

console.log('\nand Noted is still the honest end of knowing');

reset([handed(11)]);
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'Noted — read the sweep of acme/widgets.', option: 'noted' });
check('the answer is accepted', res.status === 200, JSON.stringify(res.json));
check('the card closes', card().status === 'closed', card().status);
check('and nothing was taken for an instruction', !/Nothing opened/.test(thread()), thread());

/* ---------------------------------------------------- two branches want the tap */

console.log('\nwith two waiting, the tap is what says which one');

reset([handed(11), handed(14)]);
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'take main’s renderRow' });
check('a sentence naming neither is an ordinary answer', card().status === 'closed', card().status);
check('and nothing is guessed at', !/Nothing opened/.test(thread()), thread());

reset([handed(11), handed(14)]);
res = await post('/api/respond', {
  workspace: 'demo',
  id: 'bc-card',
  response: 'RESOLVE #14: take main’s renderRow',
  option: 'resolve-14',
});
check('the tapped one is the one answered', /Nothing opened for #14/.test(thread()), thread());
check('and the card stays open', card().status === 'open', card().status);
check('the other row is untouched', readSweepCards()['bc-card'].prs.every((r) => r.state === 'handed-back'));

/* -------------------------------------------------------------- the two refusals */

console.log('\nand the answers that name a row it cannot act on');

reset([handed(11), handed(14)]);
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'RESOLVE #14:', option: 'resolve-14' });
check('a tap with nothing typed opens nothing', /wrote no instruction/.test(thread()), thread());
// It still commissions: the card has to be there to try again on, and closing it over a
// tap that did nothing is the failure this whole file is about.
check('and the card is still there to try again on', card().status === 'open', card().status);

reset([handed(11), { ...handed(9), state: 'resolved', said: '' }]);
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'RESOLVE #9: too late' });
check('a row that is not waiting any more is said so', /not one of the ones waiting on you/.test(thread()), thread());
check('rather than a second window on a branch somebody is already in', !/Could not open/.test(thread()), thread());

/* ------------------------------------------ and the registry it actually consults */

/**
 * The one claim `openSessions: false` cannot make: that the answer reaches the *real*
 * `resolveFor`, keyed by this repo and this number.
 *
 * Staged with a record that has no window handle — an iTerm too old to report a session
 * id — because that is the one live state `resolveFor` answers without either opening a
 * window or speaking to one. `cfg` is held by reference, so switching windows back on for
 * these two is enough, and nothing here can reach iTerm: the registry says a session
 * already has #11, and "I cannot ask" is not "it is gone".
 */
console.log('\nand it is the daemon own registry that is asked');

const resolvers = await import(LIB('resolvers.js'));
cfg.openSessions = true;

reset([handed(11)]);
resolvers.reset();
resolvers.remember('demo', 11, { branch: 'worktree-thing-11', term: null });
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'take main’s renderRow' });
check('a session it cannot ask about is not a second window', /Could not open a session on #11/.test(thread()), thread());
check('and it says so in the registry own words', /cannot be asked whether it is still there/.test(thread()), thread());
check('the card is still there to try again on', card().status === 'open', card().status);
check('and the row is still waiting on him', readSweepCards()['bc-card'].prs[0].state === 'handed-back');

/**
 * And the refusal that comes before the registry: a branch somebody got mergeable in the
 * meantime. Nothing on the card can know that — `chaseRow` stops chasing a row the moment
 * it stops moving — so it is asked of GitHub, and it is the same refusal *Resolve
 * conflicts* itself makes before a tap opens anything.
 */
reset([handed(11)]);
resolvers.reset();
gh({ mergeable: 'MERGEABLE' });
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'take main’s renderRow' });
check('a branch that stopped conflicting opens nothing', /does not report a conflict on it any more/.test(thread()), thread());
check('and no window was ever asked for', !/Could not open/.test(thread()), thread());

reset([handed(11)]);
gh({ state: 'MERGED' });
res = await post('/api/respond', { workspace: 'demo', id: 'bc-card', response: 'take main’s renderRow' });
check('one that merged since the sweep says so', /it was merged since the sweep/.test(thread()), thread());

gh({});

// And straight back off. Nothing in this repo's tests may launch iTerm, and the only thing
// standing between `resolveFor` and `/usr/bin/osascript` is a registry entry saying a
// session already has this pull request — so windows are on for exactly the requests
// above, each of which is answered before anything could be opened.
resolvers.reset();
cfg.openSessions = false;

/* ------------------------------------------------------- every other question */

console.log('\nand every other question in the inbox is untouched');

reset([handed(11)]);
res = await post('/api/respond', { workspace: 'demo', id: 'bc-ask', response: 'the second one' });
check('an ordinary question still closes on an answer', world().issues['bc-ask'].status === 'closed');
check('with nothing about sweeps on its thread', !/Nothing opened/.test((world().issues['bc-ask'].comments || []).join('\n')));
check('and the card that is not it is left alone', card().status === 'open' && readSweepCards()['bc-card'].prs[0].state === 'handed-back');

/* ------------------------------------------------------------------------ done */

for (const s of servers) s.close();
await cleanupTmp(tmp);
console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}`);
process.exit(failures ? 1 : 0);
