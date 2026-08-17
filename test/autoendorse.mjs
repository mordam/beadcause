#!/usr/bin/env node
/**
 * A repo may file without the hold — and only if asked, at exactly one of three levels.
 *
 *     npm test
 *     node test/autoendorse.mjs
 *
 * `unendorsed` is the most consequential label in beadcause: it is the difference between
 * a bead an agent invented sitting in a queue and an unattended session running on work
 * nobody has read (lib/endorse.js). `autoEndorse` switches it off — for one repo, for a
 * space, or globally, resolved in that order. That is a
 * safety property being turned off on purpose, which is a thing worth being able to do —
 * a personal repo where the only reader of the tracker is the person who would have
 * pressed Endorse pays a tap per discovery for a review that is not happening — and it is
 * also the one setting here whose failure modes are all in the same direction. So this
 * suite is about the *edges* of the switch rather than the switch:
 *
 * 1. **Off unless asked, in as many words.** Every other space default is the permissive
 *    one, because their worst case is a notification you did not want. `cfg.autoEndorse
 *    === true`, not `!== false`, so a config that has never heard of this field holds
 *    every filing exactly as it did before — which is what makes the upgrade a no-op for
 *    anybody who does not want it.
 *
 * 2. **It drops the hold and nothing else.** The priority clamp, the `agent-filed` label
 *    and the `discovered-from` edge are what an auto-endorsed bead can still be audited
 *    by *after* the fact, and with the hold gone they are the only thing left that says
 *    an agent decided this was work. A change that dropped them together would look like
 *    one feature and be two.
 *
 * 3. **It resolves per workspace, then per space, then globally.** The whole point is
 *    "yes here, no there". One config with two workspaces has to give two different
 *    answers from the same command — and "here" turned out to be finer than a space: the
 *    reason to drop the hold is that nobody but you reads *this* tracker, which is true
 *    of one checkout and not of the five sitting beside it in the same space. So there
 *    are three levels and one resolution path through them, and the answer must come
 *    from the config rather than from a flag on the command line, because a session
 *    endorsing its own discoveries is exactly what the hold is for.
 *
 * 4. **What the worker is told matches what happens.** The brief promises "nothing will
 *    be worked on it until Adam endorses it". In an auto-endorsing space that sentence is
 *    false, and a worker that reads it and then watches a session open on what it filed
 *    has been lied to by lib/session.js. This is the same trap `prMode` documents for
 *    `autoMerge`, and it is checked the same way: the brief and the command are asserted
 *    against one resolver.
 *
 * The end-to-end half runs `bin/file.js` as a real subprocess against a stub `bd`, for the
 * reason test/filing.mjs gives: a label goes missing in the argv, and a stub that took a
 * JSON blob would prove nothing about the flags `Bd.create` builds. `HOME` points into the
 * temp tree so `discoverWorkspaces` finds no real `~/beads`.
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
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-autoendorse-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { UNENDORSED, QUEUE_EXCLUDED, isHeld, assertEndorsed } = await import(LIB('endorse.js'));
const { FILED_LABEL, PRIORITY_FLOOR, DISCOVERED_FROM, beadToIssue, provenanceNotes } = await import(LIB('filing.js'));
const {
  autoEndorseAllowed,
  autoEndorseInherited,
  readSettings,
  applySettings,
  readWorkspaceSettings,
  applyWorkspaceSettings,
  spaceDetail,
  SETTINGS,
  WORKSPACE_SETTINGS,
} = await import(LIB('spaces.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

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

if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  const deps = many('--deps');
  for (const d of deps) {
    const target = d.includes(':') ? d.slice(d.indexOf(':') + 1) : d;
    if (!w.issues[target]) die('error: no issue found matching "' + target + '"');
  }
  w.issues[id] = {
    id,
    title: one('--title', ''),
    description: one('--description', ''),
    acceptance: one('--acceptance', ''),
    notes: one('--notes', ''),
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '2')),
    labels: many('--label'),
    dependencies: deps.map((d) => ({
      id: d.includes(':') ? d.slice(d.indexOf(':') + 1) : d,
      dependency_type: d.includes(':') ? d.slice(0, d.indexOf(':')) : 'blocks',
    })),
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
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
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const seed = (id, title) => ({
  id,
  title,
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
});

fs.writeFileSync(
  WORLD,
  JSON.stringify(
    {
      issues: {
        'zz-loose': seed('zz-loose', 'The bead the session in the loose space was opened on'),
        'zz-tight': seed('zz-tight', 'The bead the session in the holding space was opened on'),
      },
    },
    null,
    2
  )
);

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));

/**
 * Two workspaces in two spaces, and the difference between them is one boolean.
 *
 * `loose` is in a space that auto-endorses, `tight` is in one that does not say anything
 * and so inherits the global default. That pairing is the suite's main assertion: the
 * same command, the same config, the same process, two answers.
 */
const dirFor = (name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const LOOSE = { name: 'loose', dir: dirFor('loose') };
const TIGHT = { name: 'tight', dir: dirFor('tight') };

fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [LOOSE, TIGHT],
      spaces: [
        { name: 'Mine', workspaces: ['loose'], autoEndorse: true },
        { name: 'Shared', workspaces: ['tight'] },
      ],
    },
    null,
    2
  )
);

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

function fileIt(workspace, from, yaml) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file.js'), '-w', workspace, '--from', from], {
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

console.log('\na repo may endorse what its agents file\n');

/* ============================================== 1. off unless asked, in as many words */

await check('a config that has never heard of it holds every filing, exactly as before', () => {
  assert.equal(autoEndorseAllowed({}, 'anything'), false);
  assert.equal(autoEndorseAllowed({ spaces: [{ name: 'P', workspaces: ['a'] }] }, 'a'), false);
  assert.equal(autoEndorseAllowed(null, 'a'), false, 'and no config at all is the same answer');
});

await check('the global is the default, and `true` is the only value that means yes', () => {
  assert.equal(autoEndorseAllowed({ autoEndorse: true }, 'a'), true);
  assert.equal(autoEndorseAllowed({ autoEndorse: false }, 'a'), false);
  // The distinction that matters: everything else in lib/spaces.js reads `!== false`, so
  // a truthy-looking string would turn the hold off. Here only a real `true` does.
  assert.equal(autoEndorseAllowed({ autoEndorse: 'yes' }, 'a'), false, 'a hand-typed string is not consent');
  assert.equal(autoEndorseAllowed({ autoEndorse: 1 }, 'a'), false);
});

await check('a space overrides the global in either direction, like the PR policy and unlike the veto', () => {
  const on = { autoEndorse: false, spaces: [{ name: 'P', workspaces: ['a'], autoEndorse: true }] };
  const off = { autoEndorse: true, spaces: [{ name: 'W', workspaces: ['b'], autoEndorse: false }] };
  assert.equal(autoEndorseAllowed(on, 'a'), true, 'on for one space while the global says no');
  assert.equal(autoEndorseAllowed(off, 'b'), false, 'and off for one space while the global says yes');
  assert.equal(autoEndorseAllowed(off, 'unassigned'), true, 'a workspace in no space follows the global');
});

await check('and a space carrying something unreadable inherits rather than guessing', () => {
  const cfg = { autoEndorse: false, spaces: [{ name: 'P', workspaces: ['a'], autoEndorse: 'true' }] };
  assert.equal(autoEndorseAllowed(cfg, 'a'), false, 'the string asked for nothing legible; the hold is the safe reading');
});

/* ================================ 1b. and one workspace outranks the space it is in */

/**
 * The level this whole suite used to stop one short of, and the config on this Mac is
 * why. There are two spaces — Personal, holding beadcause, deluvia, ehatt, sophab and
 * two more, and Climative. "beadcause does not hold; the rest still do" was not sayable:
 * the space was the finest thing that could answer, so the only switch available unheld
 * six repos at once.
 */
const PER_REPO = {
  workspaces: [{ name: 'a' }, { name: 'b' }],
  spaces: [{ name: 'P', workspaces: ['a', 'b'] }],
};

await check('a workspace beats its space, in both directions, and answers only for itself', () => {
  const loose = { ...PER_REPO, spaces: [{ name: 'P', workspaces: ['a', 'b'], autoEndorse: false }], autoEndorsePerWorkspace: { a: true } };
  assert.equal(autoEndorseAllowed(loose, 'a'), true, 'on for one repo while the space holds');
  assert.equal(autoEndorseAllowed(loose, 'b'), false, 'and the repo beside it is untouched — the whole point');

  const held = { ...PER_REPO, spaces: [{ name: 'P', workspaces: ['a', 'b'], autoEndorse: true }], autoEndorsePerWorkspace: { a: false } };
  assert.equal(autoEndorseAllowed(held, 'a'), false, 'and the other direction, which a list of names could not say');
  assert.equal(autoEndorseAllowed(held, 'b'), true);
});

await check('it beats the global too, for a workspace in no space at all', () => {
  assert.equal(autoEndorseAllowed({ autoEndorse: false, autoEndorsePerWorkspace: { loose: true } }, 'loose'), true);
  assert.equal(autoEndorseAllowed({ autoEndorse: true, autoEndorsePerWorkspace: { tight: false } }, 'tight'), false);
  // The repos in no space are the ones with no card to set this from — `Other` is a
  // group the picker offers, not a space — so the resolver has to answer for them from
  // a hand-edited config, and this is that claim.
  assert.equal(autoEndorseAllowed({ autoEndorse: true, autoEndorsePerWorkspace: { tight: false } }, 'other'), true);
});

await check('and it falls through to the space on anything that is not a real boolean', () => {
  const space = [{ name: 'P', workspaces: ['a'], autoEndorse: true }];
  assert.equal(autoEndorseAllowed({ spaces: space, autoEndorsePerWorkspace: { a: 'false' } }, 'a'), true, 'a string is not an override');
  assert.equal(autoEndorseAllowed({ spaces: space, autoEndorsePerWorkspace: { a: 0 } }, 'a'), true);
  assert.equal(autoEndorseAllowed({ spaces: space, autoEndorsePerWorkspace: null }, 'a'), true, 'and neither is a missing map');
  assert.equal(autoEndorseAllowed({ spaces: space }, 'a'), true, 'nor an absent one — every existing config');
  // The direction that matters most: an unreadable override on a repo whose space says
  // nothing lands back on the global, which is the hold.
  assert.equal(autoEndorseAllowed({ autoEndorsePerWorkspace: { a: 'true' } }, 'a'), false);
});

await check('what Inherit on the repo row would resolve to is the same answer minus the repo', () => {
  const cfg = { autoEndorse: false, spaces: [{ name: 'P', workspaces: ['a'], autoEndorse: true }], autoEndorsePerWorkspace: { a: false } };
  assert.equal(autoEndorseAllowed(cfg, 'a'), false, 'the repo says no');
  assert.equal(autoEndorseInherited(cfg, 'a'), true, 'and the button has to say the space says yes');
  // Through the space to the global when the space says nothing, so the button never
  // promises the opposite of what pressing it does.
  assert.equal(autoEndorseInherited({ autoEndorse: true, autoEndorsePerWorkspace: { a: false } }, 'a'), true);
  assert.equal(autoEndorseInherited({}, 'a'), false);
});

await check('the per-repo override is three-state, writable, and refuses what it cannot read', () => {
  assert.deepEqual(
    WORKSPACE_SETTINGS,
    ['autoEndorse', 'autoMerge', 'requireApproval', 'autoShip'],
    'these four answer per repo; everything else groups by space'
  );
  const cfg = { autoEndorsePerWorkspace: {} };
  assert.equal(readWorkspaceSettings(cfg, 'a').autoEndorse, null, 'unset is inherit, not off');

  assert.deepEqual(applyWorkspaceSettings(cfg, 'a', { autoEndorse: true }), ['autoEndorse']);
  assert.equal(cfg.autoEndorsePerWorkspace.a, true);
  assert.deepEqual(applyWorkspaceSettings(cfg, 'a', { autoEndorse: true }), [], 'pressing it twice changed nothing');

  assert.deepEqual(applyWorkspaceSettings(cfg, 'a', { autoEndorse: false }), ['autoEndorse'], 'off is a value, not an absence');
  assert.equal(readWorkspaceSettings(cfg, 'a').autoEndorse, false);

  applyWorkspaceSettings(cfg, 'a', { autoEndorse: null });
  assert.equal('a' in cfg.autoEndorsePerWorkspace, false, 'null deletes the key — the only way back to inheriting');
  assert.throws(() => applyWorkspaceSettings(cfg, 'a', { autoEndorse: 'yes' }), /true, false or null/);
  assert.throws(() => applyWorkspaceSettings(cfg, 'a', { quietHours: null }), /not a per-repo setting/);
  assert.throws(() => applyWorkspaceSettings(cfg, 'a', null), /must be an object/);
});

await check('and it writes into a config that has never had the map, without touching its neighbours', () => {
  const cfg = { autoEndorse: false, autoEndorsePerWorkspace: { b: true } };
  applyWorkspaceSettings(cfg, 'a', { autoEndorse: false });
  assert.deepEqual(cfg.autoEndorsePerWorkspace, { b: true, a: false });
  const bare = { autoEndorse: false };
  applyWorkspaceSettings(bare, 'a', { autoEndorse: true });
  assert.deepEqual(bare.autoEndorsePerWorkspace, { a: true }, 'the map is made on demand');
  assert.equal(autoEndorseAllowed(bare, 'a'), true, 'and the daemon reading the same object agrees at once');
});

await check('the hold survives an upgrade: a config from before this existed answers exactly as it did', () => {
  // The one regression that would matter more than the feature. Every install on the
  // planet has no `autoEndorsePerWorkspace`, and the level being added in front of the
  // other two must be invisible to all of them.
  assert.equal(autoEndorseAllowed({}, 'a'), false);
  assert.equal(autoEndorseAllowed({ spaces: [{ name: 'P', workspaces: ['a'], autoEndorse: true }] }, 'a'), true);
  assert.equal(autoEndorseAllowed({ autoEndorse: true }, 'a'), true);
});

/* ============================================ 2. it drops the hold and nothing else */

await check('an endorsed filing loses the marker and keeps every other stamp', () => {
  const held = beadToIssue({ title: 'x', priority: 0, labels: ['api'] }, { from: 'zz-loose' });
  const free = beadToIssue({ title: 'x', priority: 0, labels: ['api'] }, { from: 'zz-loose', endorsed: true });

  assert.ok(held.labels.includes(UNENDORSED));
  assert.ok(!free.labels.includes(UNENDORSED), 'the hold is what the space switched off');
  assert.equal(isHeld({ labels: free.labels }), false, 'and lib/endorse.js agrees it is not held');

  assert.equal(free.labels[0], FILED_LABEL, 'an agent still filed it, and that is now the first thing on it');
  assert.ok(free.labels.includes('api'), 'without losing what the agent asked for');
  assert.ok(!free.labels.includes('human'), 'and it is still not a question');
  assert.equal(free.priority, PRIORITY_FLOOR, 'the P0 is still clamped — the ceiling is not the hold');
  assert.equal(free.clamped, true, 'and the clamp is still reported');
  assert.deepEqual(free.deps, [`${DISCOVERED_FROM}:zz-loose`], 'the trail back to the work that found it survives');
});

await check('the note says it was endorsed by nobody, and never promises a tap that is not coming', () => {
  const free = provenanceNotes({ rationale: 'Found while reading lib/filing.js.' }, { from: 'zz-loose', endorsed: true });
  assert.match(free, /arrived \*\*endorsed\*\*/, 'the first thing a reader needs is that this is already workable');
  // "repo" rather than "space": the answer resolves per workspace first, so a bead endorsed
  // by its repo's own override would send a reader to a space control that says nothing.
  assert.match(free, /auto-endorsement is on for this repo/, 'and why, so the setting is findable from the bead');
  assert.ok(!new RegExp(`\`${UNENDORSED}\``).test(free), 'a bead saying it is held while a session runs on it is the worse error');
  assert.ok(!/until you endorse it/.test(free));
  assert.match(free, /Found while reading lib\/filing\.js/, 'the agent’s own argument still travels');

  const held = provenanceNotes({}, { from: 'zz-tight' });
  assert.match(held, new RegExp(UNENDORSED), 'and the held wording is untouched');
  assert.match(held, /until you endorse it/);
});

/* ======================================== 3. per space, resolved from the workspace */

await check('a worker in an auto-endorsing space files ready work, and is told so', () => {
  const res = fileIt(
    'loose',
    'zz-loose',
    `- title: The drawer forgets its scroll position
  priority: 2
  description: Reopening it jumps to the top.
  rationale: Found while reading public/drawer.js.
`
  );
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.trim();
  const bead = world().issues[id];
  assert.ok(bead, `nothing landed in the tracker — ${res.stderr}`);
  assert.ok(!bead.labels.includes(UNENDORSED), `${id} arrived held in a space that endorses`);
  assert.ok(bead.labels.includes(FILED_LABEL), 'and nothing would say an agent filed it');
  assert.match(res.stderr, /endorsed/, 'the session has to be told which of the two happened');
  assert.ok(!/held for endorsement/.test(res.stderr), 'and not told the opposite');
});

await check('and it really is workable: in the queue, and past the launcher', async () => {
  const [bead] = Object.values(world().issues).filter((i) => (i.labels || []).includes(FILED_LABEL));
  const rows = await bd.ready(LOOSE, { excludeLabels: QUEUE_EXCLUDED });
  assert.ok(rows.some((r) => r.id === bead.id), `${bead.id} is endorsed and still out of every queue`);
  assert.equal((await assertEndorsed(bd, LOOSE, bead.id)).id, bead.id, 'and the launcher would open a session on it');
});

await check('the same command in the same config still holds a filing in the other space', async () => {
  const res = fileIt('tight', 'zz-tight', `- title: The router never proxies a WebSocket upgrade\n  priority: 2\n`);
  assert.equal(res.status, 0, res.stderr);
  const bead = world().issues[res.stdout.trim()];
  assert.ok(bead.labels.includes(UNENDORSED), 'one space saying yes must not answer for the others');
  assert.match(res.stderr, /held for endorsement/);
  const rows = await bd.ready(TIGHT, { excludeLabels: QUEUE_EXCLUDED });
  assert.ok(!rows.some((r) => r.id === bead.id));
  await assert.rejects(() => assertEndorsed(bd, TIGHT, bead.id), /may not be worked/);
});

await check('and no flag on the command can ask for it — the answer belongs to the space', () => {
  const src = read('bin/file.js');
  // The argv readers, not the prose: a session endorsing its own discoveries, whatever it
  // thinks of them, is the thing the hold exists to stop.
  assert.ok(!/(?:arg|has)\(\s*'--endorse/.test(src), 'the command reads an endorsement flag from argv');
  assert.match(src, /autoEndorseAllowed\(cfg, ws\.name\)/, 'and it is resolved from the space instead');
});

/* ================================= 4. the brief says what will actually happen */

await check('the brief promises the hold only where the hold is real', async () => {
  const { workPromptFor } = await import(LIB('session.js'));
  const bead = { id: 'zz-loose', title: 'x' };
  const free = workPromptFor('loose', bead, 1, null, 'Adam', { autoEndorse: true });
  const held = workPromptFor('tight', bead, 1, null, 'Adam');

  /**
   * The brief with the absolute paths taken out of it.
   *
   * The claim below is about what the brief *says* — and the brief also quotes the
   * checkout's own path four times, at `bin/file.js`, `bin/ask.js` and friends. A
   * checkout whose directory happens to contain the word would fail this for a reason
   * that has nothing to do with the prompt, which is not hypothetical: it failed on a
   * worktree called `discuss-unendorsed-3zo95`, where the only thing promising the hold
   * was a folder name. Nothing is weakened by eliding them — a path is not a promise.
   */
  const prose = (s) => s.split(ROOT).join('<repo>');

  assert.match(free, /arrives endorsed/, 'a worker told otherwise would watch a session open on what it filed');
  assert.ok(!new RegExp(UNENDORSED).test(prose(free)), 'and the word that is not true here does not appear');
  assert.ok(!/until\s+Adam endorses it/.test(free));
  // The one sentence that has to survive either wording: what a session does next.
  assert.match(free, /carry straight on with zz-loose/);
  assert.match(free, /do not\s+work the bead you just filed/);

  assert.match(held, new RegExp(UNENDORSED), 'the default brief is untouched');
  assert.match(held, /carry straight on with zz-loose/);
});

await check('and it defaults to the hold, so a caller that says nothing cannot promise the loose one', async () => {
  const { workPromptFor } = await import(LIB('session.js'));
  assert.match(workPromptFor('tight', { id: 'zz-tight', title: 'x' }, 1, null, 'Adam'), new RegExp(UNENDORSED));
});

/* ================================================ the setting, on the phone */

await check('it is a space setting like the others: three-state, writable, and reported', () => {
  assert.ok(SETTINGS.includes('autoEndorse'));
  const space = { name: 'Mine', workspaces: ['loose'] };
  assert.equal(readSettings(space).autoEndorse, null, 'unset is inherit, not off');

  assert.deepEqual(applySettings(space, { autoEndorse: true }), ['autoEndorse']);
  assert.equal(space.autoEndorse, true);
  assert.equal(readSettings(space).autoEndorse, true);

  assert.deepEqual(applySettings(space, { autoEndorse: false }), ['autoEndorse'], 'off is a value, not an absence');
  assert.equal(readSettings(space).autoEndorse, false);

  applySettings(space, { autoEndorse: null });
  assert.equal('autoEndorse' in space, false, 'null deletes the key — the only way back to the global');
  assert.throws(() => applySettings(space, { autoEndorse: 'yes' }), /true, false or null/);
});

await check('the details screen can draw it: what the space says, what it resolves to, and per repo', () => {
  const cfg = {
    workspaces: [{ name: 'loose' }, { name: 'tight' }],
    spaces: [{ name: 'Mine', workspaces: ['loose', 'tight'], autoEndorse: true }],
  };
  const d = spaceDetail(cfg, 'Mine');
  assert.equal(d.settings.autoEndorse, true);
  assert.equal(d.defaults.autoEndorse, false, 'an Inherit button here has to read "off" on a fresh install');
  assert.ok(d.repos.every((r) => r.autoEndorse === true), 'and the per-repo panel is the answer the daemon gives');
  assert.equal(spaceDetail({ ...cfg, autoEndorse: true }, 'Mine').defaults.autoEndorse, true, 'and moves with the global');
});

await check('the repo row carries all three claims a three-state control is made of', () => {
  const cfg = {
    workspaces: [{ name: 'loose' }, { name: 'tight' }],
    spaces: [{ name: 'Mine', workspaces: ['loose', 'tight'], autoEndorse: true }],
    autoEndorsePerWorkspace: { tight: false },
  };
  const byName = Object.fromEntries(spaceDetail(cfg, 'Mine').repos.map((r) => [r.name, r]));
  // The resolved answer, what this repo itself says, and what Inherit would mean. Drawn
  // from one payload so the tag and the pressed button on a row cannot disagree.
  assert.equal(byName.tight.autoEndorse, false, 'the repo overrides the space');
  assert.equal(byName.tight.own.autoEndorse, false, 'and the Off button is the one lit');
  assert.equal(byName.tight.inherits.autoEndorse, true, 'while Inherit has to read "on" — the space says yes');
  assert.equal(byName.loose.autoEndorse, true);
  assert.equal(byName.loose.own.autoEndorse, null, 'a repo that says nothing lights Inherit, not Off');
  assert.equal(byName.loose.inherits.autoEndorse, true);
});

await check('and the page has the control, so the setting is reachable from a phone', () => {
  // public/config.js since bc-khoe.10: the space details card is a page of its own, not a
  // pane of the advocate console. Every claim below is what it always was.
  const js = read('public/config.js');
  assert.match(js, /'autoEndorse',/, 'no control on the space details card');
  assert.match(js, /r\.autoEndorse \?/, 'and the per-repo row never says which way it resolved');
  // The per-repo control writes a different body from the space's, so it must not be
  // reachable through the space handler: a press meant for one repo arriving as the
  // whole space's answer is the exact bug this feature exists to end.
  assert.match(js, /key: 'autoEndorse'/, 'the repo row is not a control');
  assert.match(js, /data-repo-set="\$\{esc\(s\.key\)\}"/, 'and the press does not carry which setting it is');
  assert.match(js, /r\.inherits\[s\.key\]/, 'and Inherit never names what it would resolve to');
  assert.ok(/closest\('\[data-repo-set\]'\)/.test(js), 'nothing on the page picks the repo press up');
  const css = read('public/style.css');
  assert.ok(css.includes('.space-repo-set'), 'the buttons sit in a row with no rule for it');
});

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
