#!/usr/bin/env node
/**
 * A chat proposal may state a fact about a bead; it may not state the daemon's records.
 *
 *     npm test
 *     node test/proposedlabels.mjs
 *
 * `POST /api/console/create` passed a card's labels straight to `bd create` with no
 * guard, while its sibling `POST /api/bead/adjust` ran every label through
 * `isProtectedLabel` (lib/verdict.js) precisely so the labels the daemon owns could not
 * be set from a form. Two of the six were always reachable — `slug('unendorsed')` is
 * `unendorsed` — and the structured ones arrived intact for the first time with bc-vriu.1,
 * which stopped lib/draft.js slugging labels so `owner:<handle>` would survive.
 *
 * What that bought, silently: a card carrying `superseded-by:bc-x` files a bead that is
 * out of every queue from the moment it exists, and one carrying `unendorsed` files work
 * no advocate will ever pick up. Neither is a thing the card offers you to type.
 *
 * **The decision this pins is not "apply isProtectedLabel here".** The two guards answer
 * different questions and give different answers for five of the eight families, and the
 * whole point of the suite is that neither list may drift into the other by accident:
 *
 * - `owner:` and `for:` are protected on an *adjust* because the ✎ posts the label set
 *   the card is showing, so a label it does not offer is destroyed by omission. A create
 *   has nothing to destroy. Both stay allowed here, and the first is pinned twice over —
 *   test/draftlabels.mjs owns the end-to-end argv assertion.
 * - `held:`, `superseded-by:` and `ship` are refused *here* and are not on the ✎'s list at
 *   all, because they are records of something that has already happened and a bead being
 *   created has no history.
 *
 * The last section is what makes that mechanical rather than a promise: it reads
 * `isProtectedLabel`'s own body out of lib/verdict.js and fails if a family is added
 * there without a decision on this side. A comment saying the two agree is worth nothing
 * the first time somebody adds a seventh.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-proposedlabels-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { daemonOnly, filterProposedLabels, isProposalException, DAEMON_ONLY } = await import(
  LIB('proposedlabels.js')
);
const { isProtectedLabel } = await import(LIB('verdict.js'));
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

const ME = 'neadamthal@gmail.com';
const HELD = 'held:20260814T033808Z:neadamthal@gmail.com';
const SUPERSEDED = 'superseded-by:bc-vriu.1';

/* ------------------------------------------------------------------- the rule */

console.log('what a proposal may not say');

await check('the endorsement hold is the daemon’s, and the reason says what it would do', () => {
  const why = daemonOnly('unendorsed');
  assert.ok(why, 'a card must not be able to file work no advocate will queue');
  assert.match(why, /advocate|endorse/i, 'the warning has to be actionable on a phone');
});

await check('so is the marker that says an agent filed it', () => {
  assert.ok(daemonOnly('agent-filed'));
  // Case is not a way round it: bd stores a label verbatim, so `Unendorsed` would be a
  // different label — but a guard that only matched one spelling would be an invitation.
  assert.ok(daemonOnly('AGENT-FILED'));
});

await check('and a lease, which belongs to a session that is running', () => {
  assert.ok(daemonOnly(HELD));
  assert.ok(daemonOnly('held:'), 'the prefix alone is no more legitimate than a full one');
});

await check('and a superseded-by, which is one third of an act bin/supersede.js does whole', () => {
  const why = daemonOnly(SUPERSEDED);
  assert.ok(why);
  assert.match(why, /supersede\.js/, 'refusing without naming the route is refusing with no way forward');
});

await check('and a ran:, which records a session that has already finished', () => {
  assert.ok(daemonOnly('ran:opus'));
});

await check('and a ship label, whose only exit is a deploy', () => {
  assert.ok(daemonOnly('ship'));
});

console.log('\nand what it may');

await check('an owner — the exception that made this a decision rather than a one-liner', () => {
  assert.equal(daemonOnly(`owner:${ME}`), null);
  assert.equal(isProposalException(`owner:${ME}`), true);
  // And it is refused by the *other* guard, which is the disagreement this file settles.
  assert.equal(isProtectedLabel(`owner:${ME}`), true);
});

await check('an addressee, for the same reason aimed at the other question', () => {
  assert.equal(daemonOnly('for:bob@example.com'), null);
  assert.equal(daemonOnly('for:everyone'), null);
  assert.equal(isProtectedLabel('for:everyone'), true, 'still protected from the ✎');
});

await check('a container, because there is no route that sets one', () => {
  // Furniture rather than work — a statement about what the bead *is*, and the only way
  // to file a standing root from a chat. Nothing records it, so nothing is being claimed.
  assert.equal(daemonOnly('container'), null);
});

await check('and every ordinary label, which is most of them', () => {
  for (const l of ['human', 'tracker', 'api', 'complexity:high', 'Needs Review', 'advocate']) {
    assert.equal(daemonOnly(l), null, `${l} means nothing to the daemon and is not its to withhold`);
  }
});

console.log('\nand the filter over a whole card');

await check('the good labels survive in order and the bad ones become warnings', () => {
  const { labels, warnings } = filterProposedLabels(
    ['unendorsed', `owner:${ME}`, SUPERSEDED, 'tracker', '', '  '],
    { ref: 'the-epic' }
  );
  assert.deepEqual(labels, [`owner:${ME}`, 'tracker']);
  assert.equal(warnings.length, 2);
  assert.ok(
    warnings.every((w) => w.startsWith('the-epic: ')),
    `a five-card proposal has to say which card: ${JSON.stringify(warnings)}`
  );
  assert.ok(warnings[0].includes('unendorsed') && warnings[1].includes(SUPERSEDED));
});

await check('a card with nothing wrong on it produces no warning at all', () => {
  const { labels, warnings } = filterProposedLabels(['api', 'tracker'], { ref: 'x' });
  assert.deepEqual(labels, ['api', 'tracker']);
  assert.deepEqual(warnings, []);
});

await check('no labels is no labels — not the ["human"] bd.create defaults to', () => {
  // `/api/console/create` passes the result straight in, and `bd.create` falls back to
  // `['human']` only when the field is *absent*. An empty array that became undefined
  // here would file every chat proposal as a question in the inbox.
  assert.deepEqual(filterProposedLabels([]).labels, []);
  assert.deepEqual(filterProposedLabels(undefined).labels, []);
});

/* ------------------------------------------------- and the argv bd is spawned with */

console.log('\nand the argv bd is actually spawned with');

const WS = { name: 'beadcause', dir: path.join(tmp, 'beadcause', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });
const CALLS = path.join(tmp, 'bd-calls.log');

/** A `bd` that creates whatever it is asked to and records every argv. `.cjs` on purpose. */
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
const labelsPassed = () => {
  const create = calls().find((c) => c[0] === 'create');
  assert.ok(create, `bd create was never reached: ${JSON.stringify(calls())}`);
  return create.filter((_a, i) => create[i - 1] === '--label');
};

const fileOne = async (bead) => {
  const id = (await post('/api/console', { workspace: WS.name })).body.id;
  resetCalls();
  const { status, body } = await post('/api/console/create', {
    id,
    // A task rather than an epic: `Bd.create` stamps this machine's owner onto an epic
    // that is not `unendorsed`, which is a real interaction with this change and has a
    // check of its own below rather than a surprise in every assertion here.
    draft: { beads: [{ ref: 'bead', title: 'A bead', type: 'task', description: 'Because.', ...bead }] },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
};

await check('a card proposing unendorsed files the bead without it, and says so', async () => {
  const body = await fileOne({ labels: ['unendorsed', 'tracker'] });
  assert.deepEqual(labelsPassed(), ['tracker'], 'the hold must not reach bd');
  assert.equal(body.created.length, 1, 'and the bead is still made — dropped, not refused');
  assert.ok(
    body.warnings.some((w) => w.includes('unendorsed')),
    `silently dropping it is the same failure as silently setting it: ${JSON.stringify(body.warnings)}`
  );
  // A warning keeps the chat open, which is the only surface the sentence can be read on.
  assert.equal(body.closed, false);
});

await check('and one proposing superseded-by is filed as work rather than as a ghost', async () => {
  const body = await fileOne({ labels: [SUPERSEDED] });
  assert.deepEqual(labelsPassed(), [], 'out of every queue from the moment it exists — bc-xl7n.44');
  assert.equal(body.created.length, 1);
  assert.ok(body.warnings.some((w) => w.includes('superseded-by')));
});

await check('and held: and ran: go the same way, on the one card', async () => {
  const body = await fileOne({ labels: [HELD, 'ran:opus', 'api'] });
  assert.deepEqual(labelsPassed(), ['api']);
  assert.equal(body.warnings.filter((w) => w.includes('dropped the label')).length, 2);
});

await check('a P0 naming its owner is still filed with it — the exception, end to end', async () => {
  // The half of bc-vriu.1 that must not regress: a chat filing a P0 for somebody else
  // says so, and `Bd.create` treats the named owner as winning over its own stamp.
  await fileOne({ priority: 0, labels: [`owner:${ME}`, 'tracker'] });
  assert.deepEqual(labelsPassed(), [`owner:${ME}`, 'tracker']);
});

await check('an epic that no longer arrives unendorsed gets the owner stamp it should have', async () => {
  // The one behaviour change beyond the labels themselves, and it is the right way round.
  // `Bd.create` stamps this machine's owner onto an epic *unless* it arrives holding
  // `unendorsed` — an agent-filed epic nobody has read yet is nobody's to own. A chat
  // proposal is read by definition, so dropping the hold hands the epic to somebody
  // rather than leaving it as the unowned root lib/ownership.js exists to clear.
  await fileOne({ type: 'epic', labels: ['unendorsed', 'tracker'] });
  assert.deepEqual(labelsPassed(), ['tracker', `owner:${ME}`]);
});

await check('and a clean card is untouched, warnings and all', async () => {
  const body = await fileOne({ labels: ['api', 'tracker'] });
  assert.deepEqual(labelsPassed(), ['api', 'tracker']);
  assert.deepEqual(body.warnings, [], 'nothing was wrong, so nothing keeps the chat open');
  assert.equal(body.closed, true);
});

/* ------------------------------------------------------- the two lists cannot drift */

console.log('\nand the two guards, which must not drift apart in silence');

await check('every family isProtectedLabel refuses is decided here, one way or the other', () => {
  // A static read of the guard itself rather than of a list of samples: samples only
  // cover what somebody remembered to add, and the failure this is guarding against is
  // a seventh family arriving with nobody thinking about the create path.
  const src = fs.readFileSync(LIB('verdict.js'), 'utf8');
  const body = src.match(/export const isProtectedLabel = \(label\) => \{([\s\S]*?)\n\};/);
  assert.ok(body, 'isProtectedLabel has moved or changed shape — read it before trusting this');
  const families = [...body[1].matchAll(/is[A-Z][A-Za-z]*Label|PROTECTED_LABELS/g)].map((m) => m[0]);
  assert.deepEqual(
    [...new Set(families)].sort(),
    ['PROTECTED_LABELS', 'isAddresseeLabel', 'isOwnerLabel', 'isRanLabel'].sort(),
    'lib/verdict.js protects a family this suite has not decided about for a create — ' +
      'add it to DAEMON_ONLY or to PROPOSAL_EXCEPTIONS in lib/proposedlabels.js, with the reason'
  );
});

await check('and the two it deliberately disagrees with are exactly owner: and for:', () => {
  const allowed = [`owner:${ME}`, 'for:bob@example.com', 'for:everyone'];
  for (const l of allowed) {
    assert.equal(isProtectedLabel(l), true, `${l} is the ✎'s to refuse`);
    assert.equal(daemonOnly(l), null, `${l} is a proposal's to state`);
  }
  // And nothing else the ✎ refuses is let through: the two plain strings and `ran:` are
  // refused by both, so the exception list is two entries and not a hole.
  for (const l of ['unendorsed', 'agent-filed', 'ran:opus']) {
    assert.equal(isProtectedLabel(l), true);
    assert.ok(daemonOnly(l), `${l} is refused by both guards`);
  }
});

await check('every refusal carries a reason long enough to act on', () => {
  assert.ok(DAEMON_ONLY.length >= 6, 'six families, and a shrinking list is a decision');
  for (const rule of DAEMON_ONLY) {
    assert.ok(rule.label, 'each rule names the label it is about, for a reader of this file');
    assert.ok(rule.why.length > 40, `"${rule.why}" is a label name, not a reason`);
  }
});

/* ------------------------------------------------------------------------ end */

for (const s of servers) s.close();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
