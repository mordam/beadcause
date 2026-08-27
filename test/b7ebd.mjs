#!/usr/bin/env node
//
// b7e-bd — the CLI half. lib/bdintrospect.js is where the source-parse and the
// raw-bd/notes matching are actually pinned (test/bdintrospect.mjs); this file drives
// the real binary as a subprocess against a fake `bd` on PATH via `bdBin` in config, the
// same shape test/b7ewrite.mjs uses for the same reason — the argv b7e-bd hands the
// installed bd, and how many times it is spawned, is the thing under test here.
//
//   npm test
//   node test/b7ebd.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-bd');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ebd-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });

/* ----------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(\`Issues chained together like beads.

Working With Issues:
  update            Update one or more issues
  reclaim           Revert stale-lease in_progress issues back to ready (dead-worker recovery)

Flags:
      --actor string   Actor name for audit trail
\`);
  process.exit(0);
}
if (args.join(' ') === 'update --help') {
  process.stdout.write(\`Update one or more issues.

Flags:
      --parent string   New parent issue ID (reparents the issue, use empty string to remove parent)
\`);
  process.exit(0);
}
if (args.join(' ') === 'reclaim --help') {
  process.stdout.write('Revert in_progress issues whose lease has gone stale back to ready.\\n');
  process.exit(0);
}
process.stderr.write('fake bd: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [] }, null, 2)
);

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir, BEADCAUSE_AGENT: 'nonexistent-test-agent' },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* --------------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-bd — CLI\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-bd/);
});

check('no arguments is refused with exit 2', () => {
  const { status, stderr } = run([]);
  assert.equal(status, 2);
  assert.match(stderr, /an intent or --method/);
});

check('"label" finds Bd.addLabel spawning `bd label add <id> <label>`, exit 0', () => {
  const { status, stdout } = run(['label']);
  assert.equal(status, 0);
  assert.match(stdout, /addLabel/);
  assert.match(stdout, /bd label add <id> <label>/);
});

check('"reparent" reports no Bd method, and names the raw bd update --parent flag, against the fake bd', () => {
  const { status, stdout } = run(['reparent']);
  assert.equal(status, 0);
  assert.match(stdout, /no Bd method wraps this/);
  assert.match(stdout, /bd update/);
  assert.match(stdout, /reparents the issue/);
});

check('--json prints parseable JSON with methods/raw/notes arrays', () => {
  const { status, stdout } = run(['label', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.intent, 'label');
  assert.ok(Array.isArray(parsed.methods) && parsed.methods.length > 0);
  assert.ok(Array.isArray(parsed.raw));
  assert.ok(Array.isArray(parsed.notes));
  assert.ok(parsed.methods.some((m) => m.shortName === 'addLabel'));
});

check('--method reopenAbandoned prints the one call site directly, with its --force flag', () => {
  const { status, stdout } = run(['--method', 'reopenAbandoned']);
  assert.equal(status, 0);
  assert.match(stdout, /reopenAbandoned/);
  assert.match(stdout, /--force/);
});

check('--method with an unknown name is refused with exit 1, naming the method count', () => {
  const { status, stderr } = run(['--method', 'notARealMethodAtAll']);
  assert.equal(status, 1);
  assert.match(stderr, /no Bd method named/);
});

check('an intent matching nothing anywhere exits 1', () => {
  const { status, stdout } = run(['zzzzzznonsense']);
  assert.equal(status, 1);
  assert.match(stdout, /none — no Bd method wraps this/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
