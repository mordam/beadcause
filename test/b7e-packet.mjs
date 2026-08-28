#!/usr/bin/env node
//
// `b7e-packet` — the approval packet as one call: ask, label, and record the ward step.
//
//   npm test
//   node test/b7e-packet.mjs
//
// bc-dgx7.80 names five sessions (dv-gr6.38, dv-gr6.41, dv-gr6.43, dv-b5d.4.3, dv-5eu.1.1)
// that each ended a Story-chain relay with the same five hand-typed calls, and the same
// one failed every time: `relaystep --role ward --step file --next adam`, rejected because
// the relay vocabulary has no role named `adam`. What this file pins:
//
// 1. **Both packet labels land in the one `bd create`** — never a `bd label add` after,
//    so there is no window in which the bead carries only one of them.
// 2. **The delivery bead is parked behind the new question.**
// 3. **The filer's step lands on the delivery bead's own relay trail with no `--next`** —
//    the fix, not a nicer error message: the command never builds the argument that was
//    getting rejected.
// 4. **A workspace with no relay, and no `--from`, records nothing** — there is no trail
//    to write a role onto, the same rule `bin/relaystep.js` follows.
// 5. **`--from` overrides the workspace's default filer, and is checked against the
//    workspace's own roles before anything is created** — an unknown role refuses with
//    nothing written, same as an unknown `-b` bead or a body with no `decision` tail.
// 6. **The Rule 1 verdict** (lib/reachable.js) is printed when `--artifact` is not given,
//    and is skipped in favour of echoing the artifact back when it is.
//
// The real `bd` is never run: the stub is a tracker in a JSON file, the way
// test/park.mjs's is, extended with `update --append-notes` for the relay write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-packet');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7e-packet-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2).filter((a, i, all) => a !== '--actor' && all[i - 1] !== '--actor');
const w = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(WORLD)}, JSON.stringify(w, null, 2));
const one = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const many = (n) => { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === n) out.push(args[i + 1]); return out; };
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };

if (args[0] === 'create') {
  const id = 'zz-n' + (Object.keys(w.issues).length + 1);
  w.issues[id] = {
    id,
    title: one('--title', ''),
    description: one('--description', ''),
    notes: '',
    status: 'open',
    issue_type: one('--type', 'task'),
    priority: Number(one('--priority', '1')),
    labels: many('--label'),
    dependencies: [],
  };
  save();
  process.stdout.write(JSON.stringify({ id }));
  process.exit(0);
}
if (args[0] === 'show') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
if (args[0] === 'dep' && args[1] === 'add') {
  const blocked = w.issues[args[2]];
  const blocker = w.issues[args[3]];
  if (!blocked || !blocker) die('Error: no issue found matching "' + (blocked ? args[3] : args[2]) + '"');
  blocked.dependencies = [...(blocked.dependencies || []), { id: blocker.id, dependency_type: 'blocks', status: blocker.status }];
  save();
  process.stdout.write('ok\\n');
  process.exit(0);
}
if (args[0] === 'update') {
  const issue = w.issues[args[1]];
  if (!issue) die('Error: no issue found matching "' + args[1] + '"');
  const text = one('--append-notes', null);
  if (text !== null) issue.notes = issue.notes ? issue.notes + '\\n' + text : text;
  save();
  process.stdout.write('ok\\n');
  process.exit(0);
}
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const issue = (id, extra = {}) => ({
  id,
  title: `bead ${id}`,
  description: '',
  notes: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  dependencies: [],
  ...extra,
});

const reset = () => {
  fs.writeFileSync(
    WORLD,
    JSON.stringify(
      {
        issues: {
          'zz-work1': issue('zz-work1', { title: 'A Story bead running through demo (no relay)' }),
          'zz-work2': issue('zz-work2', { title: 'A Story bead running through relaydemo' }),
        },
      },
      null,
      2
    )
  );
};
reset();

const world = () => JSON.parse(fs.readFileSync(WORLD, 'utf8'));
const bead = (id) => world().issues[id];
const created = () => Object.values(world().issues).filter((i) => /^zz-n/.test(i.id));

/* ------------------------------------------------------------------ the workspaces */

const wsDir = path.join(tmp, 'ws', '.beads');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(
  path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      bdBin: FAKE_BD,
      actor: 'beadcause-test',
      workspaces: [
        { name: 'demo', dir: wsDir },
        { name: 'relaydemo', dir: wsDir },
      ],
      // Deluvia-shaped but minimal: one department, `ward` as filer and as the only
      // executive role, so `rolesOf` has exactly `{aria, clio, ward}` to check `--from`
      // against.
      relays: {
        relaydemo: {
          filer: 'ward',
          packet: ['needs-approval', 'human'],
          executive: ['ward'],
          departments: {
            'dept:story': { name: 'Story', lead: 'aria', members: ['aria'], check: ['clio'] },
          },
        },
      },
    },
    null,
    2
  )
);

/* ---------------------------------------------------------------------- a git cwd */

/** A one-commit repo on `branch`, plus a second branch `off` never checked out — enough
 * for lib/reachable.js's trunk lookup to answer without a network call. */
function repo(branch) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return dir;
}
const trunkRepo = repo('main');
const featureRepo = repo('main');
execFileSync('git', ['-C', featureRepo, 'checkout', '-q', '-b', 'worktree-feature']);

/* -------------------------------------------------------------------------- runner */

const GOOD_BODY = [
  'Ship the pricing page as drafted?',
  '',
  '```decision',
  'question: Ship the pricing page as drafted?',
  'options:',
  '  - id: ship',
  '    label: Ship it',
  '    response: Ship it as drafted.',
  '    recommended: true',
  '  - id: revise',
  '    label: Send back',
  '    response: Send it back for another pass.',
  '```',
  '',
].join('\n');

const run = (args, { input = GOOD_BODY, cwd = trunkRepo } = {}) => {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

const { journalFrom } = await import(path.join(ROOT, 'lib', 'relayjournal.js'));

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(err.message).split('\n').join('\n       ')}`);
  }
}

console.log('\nb7e-packet — ask, label, and record the ward step, in one call\n');

/* --------------------------------------------------------------- the happy paths */

await check('files the packet with both labels in the one create — no window with only one', () => {
  reset();
  const { status, out } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?']);
  assert.equal(status, 0, out);
  const id = out.split('\n')[0].trim();
  assert.match(id, /^zz-n/);
  assert.deepEqual(bead(id).labels.sort(), ['human', 'needs-approval']);
});

await check('parks the delivery bead behind the new packet', () => {
  reset();
  const { out } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?']);
  const id = out.split('\n')[0].trim();
  assert.deepEqual(bead('zz-work1').dependencies.map((d) => d.id), [id]);
});

await check('a workspace with a relay and no --from records the default filer, with no --next', () => {
  reset();
  const { status, out } = run(['-w', 'relaydemo', '-b', 'zz-work2', '-t', 'Ship it?']);
  assert.equal(status, 0, out);
  const id = out.split('\n')[0].trim();
  const entries = journalFrom(bead('zz-work2').notes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'ward');
  assert.equal(entries[0].step, 'file');
  assert.equal(entries[0].next, null, 'no --next was ever passed — this is the fix, not a caught rejection');
  assert.match(out, /relay: ward · file/);
  assert.match(entries[0].note, new RegExp(id));
});

await check('a workspace with no relay, and no --from, records nothing', () => {
  reset();
  const { status, out } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?']);
  assert.equal(status, 0, out);
  assert.equal(bead('zz-work1').notes, '', 'no relay journal entry was written');
  assert.match(out, /relay: none recorded/);
});

await check('--from overrides the default filer, and must be one of the workspace\'s roles', () => {
  reset();
  const { status, out } = run(['-w', 'relaydemo', '-b', 'zz-work2', '-t', 'Ship it?', '--from', 'clio']);
  assert.equal(status, 0, out);
  const entries = journalFrom(bead('zz-work2').notes);
  assert.equal(entries[0].role, 'clio');
});

/* ------------------------------------------------------------------------ refusals */

await check('an unknown --from role is refused before the create, and nothing is written', () => {
  reset();
  const before = created().length;
  const { status, err } = run(['-w', 'relaydemo', '-b', 'zz-work2', '-t', 'Ship it?', '--from', 'nobody']);
  assert.equal(status, 3);
  assert.match(err, /`nobody` is not a role in relaydemo/);
  assert.match(err, /aria, clio, ward/);
  assert.equal(created().length, before);
  assert.equal(bead('zz-work2').notes, '');
});

await check('an unknown -b bead is refused before the create', () => {
  reset();
  const before = created().length;
  const { status, err } = run(['-w', 'demo', '-b', 'zz-ghost', '-t', 'Ship it?']);
  assert.equal(status, 1);
  assert.match(err, /no bead zz-ghost in demo/);
  assert.equal(created().length, before);
});

await check('a body with no decision tail is refused before the create', () => {
  reset();
  const before = created().length;
  const { status, err } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?'], { input: 'just some prose' });
  assert.equal(status, 1);
  assert.match(err, /nothing was asked/);
  assert.equal(created().length, before);
});

await check('--no-options bypasses the decision-tail gate', () => {
  reset();
  const { status } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'What is the staging password?', '--no-options'], {
    input: 'It rotated last week and nobody wrote the new one down.',
  });
  assert.equal(status, 0);
});

/* -------------------------------------------------------------------- Rule 1 verdict */

await check('on trunk: the Rule 1 verdict says the packet is reachable', () => {
  reset();
  const { out } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?'], { cwd: trunkRepo });
  assert.match(out, /reachable: this checkout is on `main`/);
});

await check('off trunk: the Rule 1 verdict says a repo path would 404, and points at --artifact', () => {
  reset();
  const { out } = run(['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?'], { cwd: featureRepo });
  assert.match(out, /reachable: this checkout is on `worktree-feature`, not `main`/);
  assert.match(out, /--artifact/);
});

await check('--artifact skips the verdict and echoes the url back instead', () => {
  reset();
  const { out } = run(
    ['-w', 'demo', '-b', 'zz-work1', '-t', 'Ship it?', '--artifact', 'https://claude.ai/public/abc'],
    { cwd: featureRepo }
  );
  assert.match(out, /artifact: https:\/\/claude\.ai\/public\/abc/);
  assert.doesNotMatch(out, /reachable:/);
});

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
