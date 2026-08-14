#!/usr/bin/env node
/**
 * A bead carries a complexity tier, set when it is created.
 *
 *     npm test
 *     node test/complexity.mjs
 *
 * bc-nc6o.1, the first half of the routing epic: how hard a bead is, decided by whoever
 * wrote the bead rather than guessed at by the dispatcher three days later. The tier
 * rides as a `complexity:low|medium|high` label, the same shape `repo:<token>` uses, and
 * this file is about the three things that shape has to get right.
 *
 * 1. **A proposal that names a tier files a bead carrying it.** End to end, through the
 *    real `bin/file.js` against a stub `bd`, because the failure this catches is a label
 *    that gets normalised into a field and then quietly dropped on the way to argv — and
 *    a bead whose tier went missing looks entirely ordinary right up until it opens the
 *    expensive model for a one-line fix.
 * 2. **A proposal that names none files a bead with no complexity label, and nothing
 *    errors.** Which is the whole of the tracker as it stands, so the un-tiered path is
 *    asserted more carefully than the tiered one: no label, no empty `complexity:`, no
 *    invented default.
 * 3. **Two tiers on one bead is refused the way two `repo:` labels are.** `beadComplexity`
 *    answers with a problem rather than a tier, so the router (bc-nc6o.2) has something
 *    to say rather than a coin to toss.
 *
 * Nothing here opens a window, reaches the network or touches a real tracker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-complexity-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  COMPLEXITY_PREFIX,
  TIERS,
  beadComplexity,
  complexityLabel,
  complexityLabels,
  complexityLabelsOf,
  normalizeTier,
  splitComplexity,
} = await import(LIB('complexity.js'));
const { normalizeBead, parseProposal, proposalBody, applyEdits, editedIndices } = await import(LIB('proposal.js'));
const { beadToIssue } = await import(LIB('filing.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * The same tracker-in-a-file test/filing.mjs uses, trimmed to what this suite asks of
 * it. `create` collects repeated `--label` flags the way bd does, because argv is where
 * a label goes missing and a stub taking a JSON blob would prove nothing about it.
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

if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = {
    id,
    title: one('--title', ''),
    description: one('--description', ''),
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '2')),
    labels: many('--label'),
    dependencies: many('--deps').map((d) => ({
      id: d.includes(':') ? d.slice(d.indexOf(':') + 1) : d,
      dependency_type: d.includes(':') ? d.slice(0, d.indexOf(':')) : 'blocks',
    })),
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) { process.stderr.write('Error fetching ' + args[1] + ': no issue found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify(all().filter((i) => i.status !== 'closed')));
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const reset = () =>
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-work': {
            id: 'zz-work',
            title: 'The bead the session was opened on',
            description: '',
            status: 'open',
            issue_type: 'task',
            priority: 0,
            labels: [],
          },
        },
      },
      null,
      2
    )
  );
reset();

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'demo', dir: wsDir }] }, null, 2)
);

/** `bin/file.js` as a worker runs it: YAML on stdin, ids on stdout. */
function fileIt(yaml) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'file.js'), '-w', 'demo', '--from', 'zz-work'], {
    input: yaml,
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const filed = (id) => world().issues[id.trim()];

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

console.log('\na bead carries a complexity tier, set when it is created\n');

/* ------------------------------------------------------------- the label itself */

await check('the vocabulary is three words, cheapest first, and nothing else is a tier', () => {
  assert.deepEqual(TIERS, ['low', 'medium', 'high']);
  assert.equal(normalizeTier('HIGH'), 'high', 'a tier is read case-insensitively');
  assert.equal(normalizeTier('  low  '), 'low');
  assert.equal(normalizeTier('medium-high'), '', 'and anything else is no tier rather than a guess at one');
  assert.equal(normalizeTier(''), '');
  assert.equal(normalizeTier(undefined), '');
  assert.equal(complexityLabel('high'), `${COMPLEXITY_PREFIX}high`);
  assert.deepEqual(complexityLabels('low'), [`${COMPLEXITY_PREFIX}low`]);
  assert.deepEqual(complexityLabels(''), [], 'an unrated bead gets no label at all');
  assert.deepEqual(complexityLabels('enormous'), [], 'nor does one rated something nobody can route on');
});

await check('a bead with no tier is a real answer, not an error', () => {
  assert.deepEqual(beadComplexity({ labels: ['agent-filed', 'repo:as'] }), { tier: '', problem: null });
  assert.deepEqual(beadComplexity({ labels: [] }), { tier: '', problem: null });
  assert.deepEqual(beadComplexity(null), { tier: '', problem: null });
  assert.deepEqual(beadComplexity({}), { tier: '', problem: null }, 'a row with no labels key at all');
  assert.deepEqual(complexityLabelsOf({ labels: ['a', 'complexity:low'] }), ['complexity:low']);
});

await check('one tier reads back, however it was written and however often', () => {
  assert.deepEqual(beadComplexity({ labels: ['complexity:high'] }), { tier: 'high', problem: null });
  assert.deepEqual(beadComplexity({ labels: ['Complexity:High'] }), { tier: 'high', problem: null });
  assert.deepEqual(
    beadComplexity({ labels: ['complexity:low', 'complexity:low'] }),
    { tier: 'low', problem: null },
    'one answer written twice is not a conflict'
  );
  assert.deepEqual(beadComplexity('medium'), { tier: 'medium', problem: null }, 'a caller may pass the tier itself');
});

await check('two tiers on one bead is refused, the way two repo: labels are', () => {
  const two = beadComplexity({ labels: ['complexity:low', 'complexity:high'] });
  assert.equal(two.tier, null, 'not a tier, and not the empty answer either');
  assert.match(two.problem, /2 complexity tiers/);
  assert.match(two.problem, /complexity:low/);
  assert.match(two.problem, /complexity:high/);
  assert.match(two.problem, /will not guess/);
});

await check('a label that names no tier is a problem, not silence', () => {
  const bare = beadComplexity({ labels: ['complexity:'] });
  assert.equal(bare.tier, null);
  assert.match(bare.problem, /names no tier/);
  const junk = beadComplexity({ labels: ['complexity:enormous'] });
  assert.equal(junk.tier, null, 'a typo must not be indistinguishable from a bead nobody rated');
  assert.match(junk.problem, /enormous/);
  assert.equal(beadComplexity('enormous').tier, null, 'and the same from a bare string');
});

await check('splitComplexity takes the tier out of the labels, whichever way it was given', () => {
  assert.deepEqual(splitComplexity(['api', 'complexity:high']), { labels: ['api'], tier: 'high' });
  assert.deepEqual(splitComplexity(['api'], 'low'), { labels: ['api'], tier: 'low' });
  assert.deepEqual(
    splitComplexity(['complexity:low'], 'high'),
    { labels: [], tier: 'high' },
    'the field wins over the label, and the label never survives as a second copy'
  );
  assert.deepEqual(
    splitComplexity(['complexity:low', 'complexity:high']),
    { labels: [], tier: '' },
    'two tiers before anything exists loses both — the bead files unrated, which routes expensive'
  );
});

/* ------------------------------------------------- a proposal that names a tier */

await check('a proposed bead carries the tier as a field, from a field or from a label', () => {
  assert.equal(normalizeBead({ title: 'x', complexity: 'high' }).complexity, 'high');
  assert.equal(normalizeBead({ title: 'x', tier: 'LOW' }).complexity, 'low');
  assert.equal(normalizeBead({ title: 'x', labels: ['complexity:medium'] }).complexity, 'medium');
  assert.deepEqual(
    normalizeBead({ title: 'x', labels: ['api', 'complexity:medium'] }).labels,
    ['api'],
    'and it is not left in the labels as well, where the two could drift apart'
  );
  assert.equal(normalizeBead({ title: 'x' }).complexity, '', 'a bead that names none says so');
  assert.equal(normalizeBead({ title: 'x', complexity: 'quite hard' }).complexity, '', 'as does one nobody can read');
  assert.equal(normalizeBead('just a title').complexity, '', 'including the bare-string shorthand');
});

await check('the tier survives the block it was written in', () => {
  const src = [
    '```beadproposal',
    'workspace: demo',
    'beads:',
    '  - title: Rework the resolver',
    '    type: task',
    '    priority: 2',
    '    complexity: high',
    '  - title: Fix the typo in the banner',
    '    complexity: low',
    '  - title: Something nobody rated',
    '```',
  ].join('\n');
  const parsed = parseProposal(src);
  assert.deepEqual(
    parsed.beads.map((b) => b.complexity),
    ['high', 'low', '']
  );

  // proposalBody re-emits the block, and that re-emitted block is what the server
  // creates from — so a tier that renders but does not round-trip is a tier that is
  // shown to Adam and then thrown away.
  const body = proposalBody('demo', parsed.beads);
  assert.match(body, /high complexity/, 'the row says so where the type and the priority are');
  assert.match(body, /complexity: high/);
  const back = parseProposal(body);
  assert.deepEqual(
    back.beads.map((b) => b.complexity),
    ['high', 'low', ''],
    'including the un-tiered one, which must not gain a tier by being rendered'
  );
  assert.ok(!/complexity: ''/.test(body), 'an unrated bead emits no complexity key at all');
});

await check('adjusting the tier on the card is an adjustment, and clearing it is allowed', () => {
  const beads = parseProposal('```beadproposal\nbeads:\n  - title: A bead\n    complexity: low\n```').beads;
  const raised = applyEdits(beads, { 1: { complexity: 'high' } });
  assert.equal(raised[0].complexity, 'high', 'you are the last reader before a session runs on that rating');
  assert.deepEqual(editedIndices(beads, raised), [1], 'and the row says it was adjusted');
  const cleared = applyEdits(beads, { 1: { complexity: '' } });
  assert.equal(cleared[0].complexity, '', 'unrated is a choice, not a blank');
  assert.deepEqual(editedIndices(beads, cleared), [1]);
});

/* ------------------------------------------------------------- onto the bead */

await check('beadToIssue writes the tier with the other labels, and invents none', () => {
  const rated = beadToIssue(normalizeBead({ title: 'x', complexity: 'high', labels: ['api'] }), { from: 'zz-work' });
  assert.ok(rated.labels.includes('complexity:high'));
  assert.ok(rated.labels.includes('api'), 'without losing what the agent asked for');
  assert.equal(rated.labels[0], 'unendorsed', 'and without displacing the marker that has teeth');

  const unrated = beadToIssue(normalizeBead({ title: 'x' }), { from: 'zz-work' });
  assert.equal(
    unrated.labels.filter((l) => l.startsWith(COMPLEXITY_PREFIX)).length,
    0,
    'a bead that named no tier carries no label — not an empty one, and not a default'
  );

  const junk = beadToIssue({ title: 'x', complexity: 'enormous' }, {});
  assert.equal(junk.labels.filter((l) => l.startsWith(COMPLEXITY_PREFIX)).length, 0);
});

await check('adjusting a real bead does not take its tier off as collateral', async () => {
  // The endorsement queue's ✎ posts the label set the card is showing, and "remove what
  // I no longer see" is how a removal is expressed — so a tier lifted out of the labels
  // by the proposal normaliser would be removed by an adjust that only fixed a title.
  const { normalizeEdits } = await import(LIB('verdict.js'));
  const out = normalizeEdits({ title: 'A better title', labels: ['api', 'complexity:high'] });
  assert.deepEqual(out.labels, ['api', 'complexity:high']);
  assert.equal(out.title, 'A better title');
  assert.ok(!('complexity' in out), 'and no field nothing downstream would write');
  assert.deepEqual(
    normalizeEdits({ labels: ['complexity:low', 'unendorsed'] }).labels,
    ['complexity:low'],
    'the tier is an ordinary label here — the hold is the one that may not be typed off'
  );
});

/* ----------------------------------------------------------- the command, end to end */

await check('a proposal that names a tier files a bead carrying it', () => {
  const res = fileIt('- title: Rework the resolver\n  complexity: high\n  description: Because.\n');
  assert.equal(res.status, 0, res.stderr);
  const bead = filed(res.stdout);
  assert.ok(bead, `expected an id on stdout, got ${JSON.stringify(res.stdout)}`);
  assert.ok(bead.labels.includes('complexity:high'), `labels were ${bead.labels.join(', ')}`);
  assert.deepEqual(beadComplexity(bead), { tier: 'high', problem: null }, 'and it reads back as the tier it was given');
});

await check('a proposal that names none files a bead with no complexity label, and nothing errors', () => {
  const res = fileIt('- title: Something nobody rated\n  description: Because.\n');
  assert.equal(res.status, 0, res.stderr);
  const bead = filed(res.stdout);
  assert.deepEqual(
    bead.labels.filter((l) => l.toLowerCase().startsWith(COMPLEXITY_PREFIX)),
    [],
    `labels were ${bead.labels.join(', ')}`
  );
  assert.deepEqual(beadComplexity(bead), { tier: '', problem: null });
  assert.ok(!/complexity/i.test(res.stderr), 'and it is not something the session is warned about');
});

await check('a tier nobody can route on is dropped rather than filed as itself', () => {
  const res = fileIt('- title: Rated in a language of its own\n  complexity: quite hard\n');
  assert.equal(res.status, 0, res.stderr);
  const bead = filed(res.stdout);
  assert.deepEqual(bead.labels.filter((l) => l.toLowerCase().startsWith(COMPLEXITY_PREFIX)), []);
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
