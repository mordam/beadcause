#!/usr/bin/env node
/**
 * A worker creates the bead itself, and it arrives held.
 *
 *     npm test
 *     node test/filing.mjs
 *
 * The inversion at the middle of bc-3zo9: a session that finds work mid-task used to
 * file a question and wait for a button; it now files the bead. Everything that makes
 * that safe rather than reckless is a stamp on the bead at the moment of creation, and
 * a stamp that goes missing fails *silently* — the bead looks entirely ordinary, so it
 * is queued, launched, and worked before anyone has read its title. That is the failure
 * this file exists to catch, and it is checked end to end rather than by unit: the
 * command is run as a real subprocess against a real `Bd` and a stub `bd` binary, and
 * the assertions are made against what actually landed in the tracker.
 *
 * Four things have to be true of every bead filed this way:
 *
 * 1. **It exists.** The command creates it and prints its id — the whole point of the
 *    inversion, and the thing a proposal could not do.
 * 2. **It is `unendorsed`.** Which is only worth anything because of bc-3zo9.1, so the
 *    hold itself is re-asserted here from the far end: `Bd.ready` must not return the
 *    bead this command just filed, and `assertEndorsed` must refuse it. Those two are
 *    tested properly in test/endorse.mjs; what is tested here is that the bead a worker
 *    files is genuinely one of the ones they refuse.
 * 3. **It says where it came from.** `agent-filed` for "an agent decided this was
 *    work", and a `discovered-from` edge back to the bead being worked when it was
 *    found. The label is how you audit the feature after the marker comes off; the edge
 *    is the only trail back once the session that had the reason on screen is gone.
 * 4. **It cannot outrank the work Adam chose.** An agent filing at P0 is clamped, and
 *    told so rather than silently overruled.
 *
 * Nothing here opens a window, reaches the network or touches a real tracker. `HOME` is
 * inside the temp directory for the subprocess, so `discoverWorkspaces` finds no `~/beads`
 * and the only workspace in play is the one this file wrote.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-filing-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED, QUEUE_EXCLUDED, isHeld, assertEndorsed } = await import(LIB('endorse.js'));
const {
  FILED_LABEL,
  FILED_WHILE_PREFIX,
  PRIORITY_FLOOR,
  DISCOVERED_FROM,
  clampPriority,
  withDiscoveredFrom,
  filedWhileLabel,
  filedWhileTarget,
  beadToIssue,
  fileBeads,
} = await import(LIB('filing.js'));
const { parseDecision, decisionTail } = await import(LIB('decision.js'));
const { parseSurface } = await import(LIB('beadfiles.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, and a `bd` that reads and writes it.
 *
 * `create` is implemented the way bd implements it — repeated `--label` and `--deps`,
 * a `--json` object carrying the new id — because the flags *are* what is under test.
 * A stub that took a JSON blob would prove nothing about the argv `Bd.create` builds,
 * and the argv is where a label goes missing.
 *
 * `ready` honours `--exclude-label` for the same reason: the assertion that a filed
 * bead never reaches a queue has to survive a `bd` that is doing the filtering, since
 * that is the one that runs in production.
 *
 * **And `create` refuses a second edge to the same bead, which is bc-xl7n.65 and the one
 * rule here that is modelled from a real refusal rather than from the docs.** bd holds
 * one typed edge per pair; `--parent X` writes a `parent-child` one, so `--deps
 * discovered-from:X` alongside it fails the whole create with
 *
 *     validation failed: dependency → X already exists with type "parent-child"
 *     (requested "discovered-from"); remove it first with 'bd dep remove' then re-add
 *
 * That is not a corner: it is what `lib/homing.js` asks for every time the bead being
 * worked is itself a root, and twenty-two beads landed parentless on the real tracker
 * before anybody attributed it. A stub that quietly took both would go green over the
 * bug, which is what the old one did.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const all = () => Object.values(w.issues);
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

const typeOf = (d) => (d.includes(':') ? d.slice(0, d.indexOf(':')) : 'blocks');
const targetOf = (d) => (d.includes(':') ? d.slice(d.indexOf(':') + 1) : d);

if (args[0] === 'create') {
  const title = one('--title', '');
  // The one create this world refuses, so a partial failure can be asserted: Dolt
  // losing a lock race looks exactly like this from here.
  if (/^BOOM/.test(title)) die('error: database is locked');
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  const parent = one('--parent', '');
  // A parent bd will not take, for a reason out here nobody models: the second half of
  // the refusal path, where the bead is re-filed with no parent and the session has to
  // be told so rather than told where it was supposed to have gone.
  if (/^REFUSE/.test(title) && parent) die('Error: cannot parent a task to ' + parent);
  if (parent && !w.issues[parent]) die('Error: no issue found matching "' + parent + '"');
  const deps = many('--deps');
  for (const d of deps) {
    const target = targetOf(d);
    if (!w.issues[target]) die('error: no issue found matching "' + target + '"');
    // One edge per pair, typed — bd's own words, verbatim.
    if (parent && target === parent && typeOf(d) !== 'parent-child') {
      die(
        'Error: validation failed: dependency ' + id + ' -> ' + target +
          ' already exists with type "parent-child" (requested "' + typeOf(d) +
          '"); remove it first with \\'bd dep remove\\' then re-add'
      );
    }
  }
  w.issues[id] = {
    id,
    title,
    description: one('--description', ''),
    acceptance: one('--acceptance', ''),
    notes: one('--notes', ''),
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '2')),
    labels: many('--label'),
    parent: parent || '',
    dependencies: deps.map((d) => ({ id: targetOf(d), dependency_type: typeOf(d) })),
    actor: one('--actor', ''),
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
// The shape lib/ancestry.js reads: one JSON row per line, the parent link riding in
// dependencies as a parent-child edge exactly as a real export carries it. Without
// this the graph is empty, nothing is a root, and every filing in this suite would be
// homed nowhere -- which is to say the whole of bc-rfnr.8 would go untested here.
if (args[0] === 'export') {
  const lines = all().map((i) =>
    JSON.stringify({
      ...i,
      dependencies: [
        ...(i.parent ? [{ issue_id: i.id, depends_on_id: i.parent, type: 'parent-child' }] : []),
        ...(i.dependencies || []).map((d) => ({ issue_id: i.id, depends_on_id: d.id, type: d.dependency_type })),
      ],
    })
  );
  process.stdout.write(lines.join('\\n'));
  process.exit(0);
}
if (args[0] === 'ready') {
  const off = many('--exclude-label');
  const rows = all()
    .filter((i) => i.status === 'open' && !i.assignee)
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list') {
  const off = many('--exclude-label');
  const rows = all()
    .filter((i) => i.status !== 'closed')
    .filter((i) => !(i.labels || []).some((l) => off.includes(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'comments') { process.stdout.write('[]'); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  ...extra,
});

/**
 * The bead a worker is working when it finds something, the root above it, and one
 * already-filed bead.
 *
 * `zz-root` is the whole of lib/homing.js in this world: a P0 epic carrying `unsorted`,
 * so it is both the root `zz-work` descends from *and* the backlog a filing with no
 * usable `--from` falls into. Before bc-xl7n.65 this suite had no roots at all, so every
 * bead it filed was homed nowhere and the parent path — the one that was broken in
 * production for a fortnight — was never once executed here.
 */
const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-root': issue('zz-root', {
            title: 'The unsorted backlog',
            issue_type: 'epic',
            priority: 0,
            labels: ['unsorted'],
          }),
          'zz-work': issue('zz-work', { title: 'The bead the session was opened on', parent: 'zz-root' }),
          'zz-old': issue('zz-old', { title: 'The router never proxies a WebSocket upgrade', parent: 'zz-root' }),
        },
      },
      null,
      2
    )
  );
};
reset();

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const filedBeads = () => Object.values(world().issues).filter((i) => (i.labels || []).includes(FILED_LABEL));

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
const ws = { name: 'demo', dir: wsDir };
const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/* ------------------------------------------------------- the command, as a worker runs it */

fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [ws] }, null, 2)
);

/**
 * Run `bin/file.js` the way the brief tells a worker to: YAML on stdin, ids on stdout.
 *
 * `HOME` points into the temp tree so `discoverWorkspaces` finds nothing to add — a
 * real `~/beads` would be reconciled into the config and print onto stdout, which is
 * the stream the ids come back on.
 */
function fileIt(yaml, args = ['-w', 'demo', '--from', 'zz-work']) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file.js'), ...args], {
    input: yaml,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

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

console.log('\na worker creates the bead itself, marked unendorsed\n');

/* ------------------------------------------------------------ what goes on a bead */

await check('the priority ceiling holds what an agent files below the work Adam chose', () => {
  assert.deepEqual(clampPriority(0), { priority: PRIORITY_FLOOR, asked: 0, clamped: true });
  assert.deepEqual(clampPriority('P1'), { priority: PRIORITY_FLOOR, asked: 1, clamped: true });
  assert.deepEqual(clampPriority(2), { priority: 2, asked: 2, clamped: false });
  assert.deepEqual(clampPriority(4), { priority: 4, asked: 4, clamped: false }, 'a backlog bead stays in the backlog');
  assert.equal(clampPriority(undefined).priority, PRIORITY_FLOOR, 'and a bead that said nothing lands on the floor');
  assert.equal(clampPriority('nonsense').asked, PRIORITY_FLOOR, 'as does one that said something unreadable');
});

await check('the discovered-from edge is added once, and never over one the agent wrote', () => {
  assert.deepEqual(withDiscoveredFrom([], 'zz-work'), [`${DISCOVERED_FROM}:zz-work`]);
  assert.deepEqual(withDiscoveredFrom(['blocks:zz-a'], 'zz-work'), ['blocks:zz-a', `${DISCOVERED_FROM}:zz-work`]);
  assert.deepEqual(
    withDiscoveredFrom([`${DISCOVERED_FROM}:zz-work`], 'zz-work'),
    [`${DISCOVERED_FROM}:zz-work`],
    'two edges of the same type between the same pair is noise on the graph sheet'
  );
  assert.deepEqual(withDiscoveredFrom(['zz-work'], 'zz-work'), ['zz-work'], 'and a bare id is already that edge');
  assert.deepEqual(withDiscoveredFrom(['blocks:zz-a'], ''), ['blocks:zz-a'], 'no --from, no edge invented');
});

await check('and it is never an edge to the bead\'s own parent, because bd holds one per pair', () => {
  assert.deepEqual(
    withDiscoveredFrom([], 'zz-root', { parent: 'zz-root' }),
    [],
    'a worker on a root files under that root — asking for both edges fails the whole create'
  );
  assert.deepEqual(
    withDiscoveredFrom([], 'zz-work', { parent: 'zz-root' }),
    [`${DISCOVERED_FROM}:zz-work`],
    'while a worker on a child of a root still gets its trail back'
  );
  assert.deepEqual(
    withDiscoveredFrom(['blocks:zz-root', 'blocks:zz-a'], 'zz-work', { parent: 'zz-root' }),
    ['blocks:zz-a', `${DISCOVERED_FROM}:zz-work`],
    'and a dep the agent wrote at the parent goes too — bd would refuse the create over it just as readily'
  );
  assert.deepEqual(
    withDiscoveredFrom([], 'zz-work', {}),
    [`${DISCOVERED_FROM}:zz-work`],
    'no parent, nothing to collide with'
  );
});

await check('bdReason finds what bd said, past the command it echoed back', async () => {
  const { bdReason } = await import(LIB('filing.js'));
  const real = new Error(
    'bd create --title x --description line one\nline two failed in demo: Error: validation failed: dependency'
  );
  real.stderr = 'Warning: pending schema migrations\nError: validation failed: dependency -> zz-root already exists\n';
  assert.equal(
    bdReason(real),
    'Error: validation failed: dependency -> zz-root already exists',
    'a --description with newlines put the reason past the first line, where nothing ever read it'
  );
  const killed = new Error('bd export timed out in demo: still running after 120s, killed rather than broken');
  killed.stderr = '';
  assert.match(bdReason(killed), /timed out in demo/, 'and a child this process killed says nothing on stderr at all');
});

await check('filedWhileLabel and filedWhileTarget round-trip, and are `null`/`""` on nothing', () => {
  assert.equal(filedWhileLabel('zz-work'), `${FILED_WHILE_PREFIX}zz-work`);
  assert.equal(filedWhileLabel(''), null, 'no bead being worked, no stamp to invent');
  assert.equal(filedWhileLabel(undefined), null);
  assert.equal(filedWhileTarget(`${FILED_WHILE_PREFIX}zz-work`), 'zz-work');
  assert.equal(filedWhileTarget('agent-filed'), '', 'an unrelated label is not this one');
  assert.equal(filedWhileTarget(''), '');
});

await check('the marker goes on first, and `human` never does', () => {
  const out = beadToIssue({ title: 'x', priority: 2, labels: ['api'] }, { from: 'zz-work' });
  assert.equal(out.labels[0], UNENDORSED, 'a reader of bd show sees why it is not being worked, first');
  assert.ok(out.labels.includes(FILED_LABEL), 'and that an agent filed it');
  assert.ok(out.labels.includes('api'), 'without losing what the agent asked for');
  assert.ok(!out.labels.includes('human'), 'a filed bead is not a question and must not land in the inbox');
  assert.equal(isHeld({ labels: out.labels }), true, 'and lib/endorse.js agrees it is held');
});

/* --------------------------------------------------- the command, end to end */

await check('a worker files a bead unattended, and gets its id back', () => {
  const res = fileIt(`- title: The drawer forgets its scroll position
  type: bug
  priority: 2
  description: |
    Reopening it jumps to the top.
  acceptance: It reopens where you left it.
  rationale: Found while reading public/drawer.js for zz-work.
`);
  assert.equal(res.status, 0, res.stderr);
  const ids = res.stdout.trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, `one id on stdout, got ${JSON.stringify(res.stdout)}`);
  const bead = world().issues[ids[0]];
  assert.ok(bead, 'and it is really in the tracker');
  assert.equal(bead.title, 'The drawer forgets its scroll position');
  assert.equal(bead.issue_type, 'bug');
  assert.equal(bead.description.trim(), 'Reopening it jumps to the top.');
  assert.equal(bead.acceptance, 'It reopens where you left it.');
});

await check('it arrives held, provenanced, and pointing back at the work that found it', () => {
  const [bead] = filedBeads();
  assert.ok(bead.labels.includes(UNENDORSED), `no marker on ${bead.id} — it would be worked tonight`);
  assert.ok(bead.labels.includes(FILED_LABEL), 'and nothing would say an agent filed it');
  assert.ok(
    bead.labels.includes(`${FILED_WHILE_PREFIX}zz-work`),
    'and the console can read which bead was being worked, without walking the graph'
  );
  assert.deepEqual(
    bead.dependencies,
    [{ id: 'zz-work', dependency_type: DISCOVERED_FROM }],
    'the trail back to the session that found it'
  );
  assert.match(bead.notes, /Filed by an agent while working zz-work/);
  assert.match(bead.notes, /How it was found:.*public\/drawer\.js/s, 'the rationale survives, out of the description');
  assert.match(bead.notes, new RegExp(UNENDORSED), 'and the notes say what that means to whoever reads the queue');
  assert.equal(bead.description.includes('Filed by an agent'), false, 'the description stays what the agent wrote');
});

await check('and nothing will pick it up — not the queue, and not the launcher', async () => {
  const [bead] = filedBeads();
  const rows = await bd.ready(ws, { excludeLabels: QUEUE_EXCLUDED });
  assert.ok(!rows.some((r) => r.id === bead.id), `${bead.id} was ready to work the moment it was filed`);
  assert.ok(rows.some((r) => r.id === 'zz-work'), 'while ordinary work is still queued');
  await assert.rejects(() => assertEndorsed(bd, ws, bead.id), /may not be worked/, 'handed straight to the launcher');
});

await check('the whole worker brief is honest about it: a real bead, held, and carry on', async () => {
  const { workPromptFor } = await import(LIB('session.js'));
  const brief = workPromptFor('demo', { id: 'zz-work', title: 'x' }, 1, null, 'Adam');
  assert.match(brief, /bin\/file\.js -w demo --from zz-work/, 'the command a worker is told to run');
  assert.match(brief, /creates the bead for real/);
  assert.match(brief, new RegExp(UNENDORSED));
  assert.match(brief, /carry straight on with zz-work/);
});

/* ------------------------------------------- bc-xl7n.65: the worker who is on a root */

await check('a bead filed while working a root lands UNDER that root, not beside it', () => {
  const res = fileIt(
    `- title: The census counts nothing
  description: |
    Nothing in the repo counts beads with no root above them.
  rationale: Found while working zz-root.
`,
    ['-w', 'demo', '--from', 'zz-root']
  );
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.ok(bead, 'the bead exists');
  assert.equal(
    bead.parent,
    'zz-root',
    'this is the whole bug: `--parent zz-root` with `--deps discovered-from:zz-root` is refused by bd, ' +
      'the parent is dropped rather than the discovery, and the bead lands held and undispatchable'
  );
  assert.deepEqual(bead.dependencies, [], 'the parent-child edge is the trail back, and bd will not hold both');
  assert.match(bead.notes, /Filed by an agent while working zz-root/, 'the provenance is in the prose either way');
  assert.doesNotMatch(res.stderr, /would not take/, 'and nothing was refused on the way in');
  assert.doesNotMatch(res.stderr, /NO PARENT/, 'so the session is not told its discovery is stranded');
  assert.ok(
    bead.labels.includes(`${FILED_WHILE_PREFIX}zz-root`),
    'the label survives exactly where the edge above could not — this is the case it exists for'
  );
});

await check('the stub really does refuse both edges — otherwise the check above proves nothing', async () => {
  await assert.rejects(
    () => bd.create(ws, { title: 'Two edges to one bead', parent: 'zz-root', deps: [`${DISCOVERED_FROM}:zz-root`] }),
    /already exists with type "parent-child"/,
    'bd 1.2.1 holds one typed edge per pair, and this is the sentence it refuses with'
  );
});

await check('when bd does refuse the parent, the session is told the bead is stranded', () => {
  const res = fileIt(`- title: REFUSE this one a home\n  description: x\n`);
  assert.equal(res.status, 0, 'the discovery is kept — losing it over the parent is the wrong way round');
  const bead = world().issues[res.stdout.trim()];
  assert.equal(bead.parent, '', 'the parent is what bd would not take');
  assert.match(res.stderr, /would not take "REFUSE this one a home" under zz-root/);
  assert.match(res.stderr, /cannot parent a task to zz-root/, 'and the reason bd gave, not the command it echoed');
  assert.match(res.stderr, /is filed with NO PARENT/, 'said in the summary too, where the reassuring line used to be');
  assert.match(res.stderr, new RegExp(bead.id), 'naming the bead, so adopting it is one command away');
  assert.doesNotMatch(
    res.stderr,
    /^beadcause-file: filed under /m,
    'and never "filed under zz-root" over a bead that is under nothing — that is what hid this for a fortnight'
  );
});

/* ------------------------------------------- bc-ka5y.23: a fence inside the fence */

/**
 * `bin/file.js` re-wraps the whole input in its own `beadproposal` fence and hands it
 * to `parseProposal`. If a bead's own `description` carries a fenced block of its
 * own (the normal shape for a decision bead — bc-ka5y.22 is exactly this), YAML's
 * block-scalar indentation puts that inner closing fence a few spaces in, and an
 * unanchored closing alternative in `BLOCK_RE` was happy to treat an indented fence as
 * the end of the whole `beadproposal` block. Everything serialised after `description`
 * — acceptance, rationale, files, and the rest of the decision block itself — vanished,
 * with no error and an ordinary success line on stdout.
 */
await check('a description carrying its own fenced block survives whole, with everything after it', () => {
  const res = fileIt(`- title: Ship now or wait for review?
  type: decision
  priority: 2
  description: |
    Weigh shipping now against waiting for another pass.

    \`\`\`decision
    question: Ship now or wait for review?
    options:
      - id: ship
        label: Ship now
        recommended: true
      - id: wait
        label: Wait for review
    \`\`\`
  acceptance: The question is answered either way.
  rationale: Found while reading lib/proposal.js for zz-work.
`);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.ok(bead, 'and it is really in the tracker');
  // The whole description, decision block and all — not truncated at the inner fence.
  assert.match(bead.description, /Weigh shipping now against waiting for another pass\./);
  assert.match(bead.description, /```decision/);
  assert.match(bead.description, /label: Wait for review/, 'the second option, past the truncation point');
  assert.match(bead.description, /```\s*$/, 'the description ends with the decision block\'s own closing fence');
  // Everything the truncation used to drop, because field order put it after `description`.
  assert.equal(bead.acceptance, 'The question is answered either way.', 'acceptance must not go missing');
  assert.match(bead.notes, /How it was found:.*lib\/proposal\.js/s, 'rationale must not go missing');
  // And the decision block inside the description is itself intact and well-formed.
  const { decision, error } = parseDecision(bead.description);
  assert.equal(error, undefined, 'the inner decision block parses as YAML');
  assert.equal(decision?.question, 'Ship now or wait for review?');
  assert.equal(decision?.options?.length, 2, 'both options survived, not just the ones before the truncation');
  assert.ok(decision?.options?.some((o) => o.recommended), 'and the recommendation on the second one');
  assert.equal(decisionTail(bead.description).ok, true, 'and it ends the way a question has to end');
});

await check('files declared alongside a fenced description survive too', () => {
  const res = fileIt(`- title: Another one with a fence in it
  description: |
    Context first.

    \`\`\`decision
    question: Which way?
    options:
      - a
      - b
    \`\`\`
  rationale: Found while reading lib/beadfiles.js for zz-work.
  files: [lib/proposal.js, lib/decision.js]
`);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.ok(bead, 'filed at all — files used to be silently dropped along with everything after description');
  assert.deepEqual(
    parseSurface(bead.description),
    ['lib/proposal.js', 'lib/decision.js'],
    'the beadfiles block bin/filing.js appends is there, past where the truncation used to cut'
  );
});

/* ----------------------------------------------------------- the awkward inputs */

await check('an agent that files a P0 is clamped, and told so on the bead', () => {
  const res = fileIt(`- title: Everything is on fire
  priority: 0
  description: It is not, but I think it is.
`);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.equal(bead.priority, PRIORITY_FLOOR, 'an agent may not put its own find at the top of the queue');
  assert.match(bead.notes, /Filed as P0, held at P2/, 'and it is recorded rather than silently overruled');
});

await check('a duplicate is flagged on the bead rather than dropped', () => {
  const res = fileIt(`- title: The router never proxies a WebSocket upgrade
  description: The terminal 404s.
`);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.ok(bead, 'a near-miss title is not proof of the same bug, so it is still filed');
  assert.match(bead.notes, /Looks like a duplicate.*zz-old/s, 'and the endorsement queue can see what it resembles');
});

await check('a --from naming a bead that is not there loses the edge, never the bead', () => {
  const res = fileIt(`- title: Filed from nowhere\n  description: x\n`, ['-w', 'demo', '--from', 'zz-nope']);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.deepEqual(bead.dependencies, [], 'the whole create would otherwise fail at the dep');
  assert.ok(bead.labels.includes(UNENDORSED), 'and it is still held');
});

await check('one bead failing does not eat the others, and the exit code says so', () => {
  const before = filedBeads().length;
  const res = fileIt(`- title: BOOM this one collides
  description: x
- title: This one is fine
  description: x
`);
  assert.equal(res.status, 4, 'a partial failure is a failure the caller has to see');
  assert.equal(res.stdout.trim().split('\n').filter(Boolean).length, 1, 'and the one that landed is still reported');
  assert.equal(filedBeads().length, before + 1);
  assert.match(res.stderr, /could not file "BOOM this one collides"/);
});

await check('YAML that names no beads is refused rather than reported as success', () => {
  assert.equal(fileIt('# nothing here\n').status, 3);
  assert.equal(fileIt('beads: []\n').status, 3);
  assert.equal(fileIt(': : : not yaml\n').status, 3);
});

await check('an unknown workspace prints the usage instead of filing anywhere', () => {
  const res = fileIt('- title: x\n', ['-w', 'nosuchworkspace']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: beadcause-file/);
});

/* ------------------------------------------------------- the library, without a CLI */

await check('fileBeads reports both halves, so a caller can say what it got', async () => {
  const res = await fileBeads(bd, ws, [{ title: 'BOOM again' }, { title: 'A second find', priority: 3 }], {
    from: 'zz-work',
  });
  assert.equal(res.filed.length, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.filed[0].priority, 3, 'a low priority is left alone');
  assert.match(res.failed[0].error, /locked/, 'and the reason survives to whoever has to report it');
});

/* --------------------------------------- bc-xl7n.128: the warning judged per bead */

/**
 * A second, minimal tracker — one open epic root, and deliberately no `unsorted`
 * label — because `zz-root` above already carries one, and this warning only ever
 * fires on a workspace that has roots but no pile to catch what falls through
 * (`home.gated && !home.parent`). No `--from` is passed in any of the checks below,
 * so `homeFor`'s `overFrom` arm never applies either — the graph's only root is
 * exactly what `gated` is answering about.
 */
const WORLD2 = path.join(tmp, 'world2.json');
const FAKE_BD2 = path.join(tmp, 'bd2');
fs.writeFileSync(
  FAKE_BD2,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD2)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD2)}, JSON.stringify(w, null, 2));
const all = () => Object.values(w.issues);
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(...String(args[i + 1] || '').split(',')); return out.filter(Boolean); };

if (args[0] === 'create') {
  const id = 'w2-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = {
    id,
    title: one('--title', ''),
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '2')),
    labels: many('--label'),
    parent: one('--parent', ''),
    dependencies: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'export') {
  const lines = all().map((i) =>
    JSON.stringify({
      ...i,
      dependencies: i.parent ? [{ issue_id: i.id, depends_on_id: i.parent, type: 'parent-child' }] : [],
    })
  );
  process.stdout.write(lines.join('\\n'));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  WORLD2,
  JSON.stringify(
    { issues: { 'w2-root': issue('w2-root', { title: 'An open epic, no unsorted label', issue_type: 'epic', priority: 1 }) } },
    null,
    2
  )
);
const ws2 = { name: 'demo2', dir: path.join(tmp, 'ws2', '.beads') };
fs.mkdirSync(ws2.dir, { recursive: true });
const bd2 = new Bd({ bin: FAKE_BD2, actor: 'beadcause-test' });

await check('a batch of epics at the ordinary floor gets no false claim at all', async () => {
  // **The arm a real caller can actually reach.** Neither production caller passes a
  // `floor` (bin/file.js, lib/sessionaudit.js), so `clampPriority` cannot return 0 here
  // and `isRoot` can only ever be true by `type`. Nothing in this batch asks for a
  // priority at all — both land at the P2 floor — so `isEpic` is the whole of what
  // suppresses the warning, and hard-coding `type: 'task'` into the gate (i.e. deleting
  // the epic half outright) reds exactly this check and nothing else.
  const warnings = [];
  const res = await fileBeads(
    bd2,
    ws2,
    [{ title: 'A second epic, decided on its own', type: 'epic' }, { title: 'Another programme nobody has to adopt', type: 'epic' }],
    { onWarn: (w) => warnings.push(w) }
  );
  assert.equal(res.filed.length, 2, JSON.stringify(res));
  assert.equal(res.filed[0].priority, 2, 'and it is the epic-ness carrying this, not a P0 the floor let through');
  assert.equal(res.filed[1].priority, 2, 'both of them — neither is root by isP0');
  assert.deepEqual(warnings, [], 'nothing in this batch needs a home, so nothing should say it does not have one');
});

await check('a batch that is entirely P0 gets no false claim either, floor permitting', async () => {
  // The other half of `isRoot`, and the one no caller reaches today — `floor: 0` is
  // what makes a P0 survive `clampPriority` at all. Defensive, and what pins the
  // `floor` being threaded into the judgement rather than the raw asked-for priority
  // being read: drop the `floor` argument from the gate and this check reds.
  const warnings = [];
  const res = await fileBeads(
    bd2,
    ws2,
    [{ title: 'Urgent, and nothing above it yet', priority: 0 }, { title: 'So is this one', priority: 0 }],
    { onWarn: (w) => warnings.push(w), floor: 0 }
  );
  assert.equal(res.filed.length, 2, JSON.stringify(res));
  assert.deepEqual(warnings, [], 'a P0 is workable with nothing above it, whatever its type');
});

await check('one ordinary bead in the batch still gets the warning, beside a root-shaped one', async () => {
  const warnings = [];
  const res = await fileBeads(
    bd2,
    ws2,
    [{ title: 'A third epic, also fine alone' }, { title: 'An ordinary find with nowhere to go' }].map((b, i) => ({
      ...b,
      type: i === 0 ? 'epic' : 'task',
    })),
    { onWarn: (w) => warnings.push(w) }
  );
  assert.equal(res.filed.length, 2, JSON.stringify(res));
  assert.equal(warnings.length, 1, 'the batch still has a genuine orphan in it, so the warning still has to fire');
  assert.match(warnings[0], /nothing to hang this under/);
});

await check('a batch of ordinary beads alone still gets the warning — unchanged from before', async () => {
  const warnings = [];
  const res = await fileBeads(bd2, ws2, [{ title: 'Just an ordinary orphan, nothing root-shaped here' }], {
    onWarn: (w) => warnings.push(w),
  });
  assert.equal(res.filed.length, 1, JSON.stringify(res));
  assert.equal(warnings.length, 1);
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
process.exit(failures ? 1 : 0);
