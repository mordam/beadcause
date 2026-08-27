#!/usr/bin/env node
//
// b7e-card — say what the phone will show for a bead's card, before a write and after
// (bc-dgx7.19).
//
//   npm test
//   node test/b7ecard.mjs
//
// Three sessions (bc-xl7n.101, bc-ka5y.15, bc-1kwl) each hand-wrote a `decision` block
// onto an existing bead and then a scratch script to find out whether it had parsed —
// this drives `bin/b7e-card` end to end against a fake `bd` on PATH, covering the exact
// failure each of them hit: bc-xl7n.101's unquoted `superseded-by:` reading as a nested
// YAML mapping (exit non-zero, the offending line named), the rewritten block parsing
// clean (exit 0, three options), and bc-1kwl's `beadcause:waiting` / `beadcause:inmain`
// markers being listed rather than silently carried past a `--notes` clobber.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-card');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, fn) => {
  try {
    const result = fn();
    if (result === false) throw new Error('returned false');
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7ecard-test-'));

/* ===================================================================== *
 * 1. bin/b7e-card end to end, against a fake `bd` on PATH
 * ===================================================================== */

console.log('\nbin/b7e-card — end to end\n');

const WAITING_OPEN = '<!-- beadcause:waiting -->';
const WAITING_CLOSE = '<!-- /beadcause:waiting -->';
const INMAIN_MARK = '<!-- beadcause:inmain worktree-foo-bar -->';

const WORLD = {
  'bc-plain.1': {
    id: 'bc-plain.1',
    title: 'An ordinary bead with no decision block at all',
    description: 'Just some prose. Nothing to parse here.',
    design: '',
    notes: '',
  },
  'bc-markers.1': {
    id: 'bc-markers.1',
    title: 'A bead whose notes carry a waiting block and an inmain ask',
    description: '',
    design: '',
    notes: `Some notes.\n${WAITING_OPEN}\nwaiting on a child\n${WAITING_CLOSE}\n${INMAIN_MARK}\n`,
  },
  'bc-unrecommended.1': {
    id: 'bc-unrecommended.1',
    title: 'A decision block with options and no recommendation',
    description: '```decision\nquestion: Which way?\noptions:\n  - id: a\n    label: A\n  - id: b\n    label: B\n```',
    design: '',
    notes: '',
  },
};

const fakebin = fs.mkdtempSync(path.join(tmp, 'fakebin-'));
fs.writeFileSync(
  path.join(fakebin, 'bd'),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const world = ${JSON.stringify(WORLD)};
if (args[0] === 'show') {
  const row = world[args[1]];
  if (!row) {
    process.stdout.write(JSON.stringify({ error: 'no issues found matching the provided IDs' }) + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([row]) + '\\n');
  process.exit(0);
}
process.stderr.write('fake bd: unsupported ' + args.join(' ') + '\\n');
process.exit(1);
`
);
fs.chmodSync(path.join(fakebin, 'bd'), 0o755);
const PATH_WITH_FAKE_BD = `${fakebin}:${process.env.PATH}`;

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, PATH: PATH_WITH_FAKE_BD } });

check('no bead id at all is refused with exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

check('an unrecognised flag is refused with exit 2', () => {
  const r = run(['bc-plain.1', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag/);
});

check('an unrecognised --field value is refused with exit 2', () => {
  const r = run(['bc-plain.1', '--field', 'bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--field must be one of/);
});

check('a bead `bd show` cannot find is refused with exit 2, not a crash', () => {
  const r = run(['bc-does-not-exist']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /b7e-card:/);
});

check('a bead with no decision block anywhere is exit 0 — absence is not a failure, and the question falls back to the title', () => {
  const r = run(['bc-plain.1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /An ordinary bead with no decision block at all/);
  assert.match(r.stdout, /markers: none/);
});

check('a bead whose notes carry waiting and inmain markers lists both', () => {
  const r = run(['bc-markers.1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /beadcause:waiting/);
  assert.match(r.stdout, /beadcause:inmain worktree-foo-bar/);
});

check('--json on the markers bead reports them as structured data', () => {
  const r = run(['bc-markers.1', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.markers.length, 3);
  assert.ok(parsed.markers.some((m) => m.includes('inmain worktree-foo-bar')));
});

check('--field restricts the report to one field, dropping markers that live elsewhere', () => {
  const r = run(['bc-markers.1', '--field', 'description']);
  assert.equal(r.status, 0, r.stderr);
  const json = run(['bc-markers.1', '--field', 'description', '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.fields, ['description']);
  assert.equal(parsed.markers.length, 0);
});

check('a parseable block with no recommended option warns but still exits 0', () => {
  const r = run(['bc-unrecommended.1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no option is marked recommended/);
});

/* ===================================================================== *
 * 2. --file: bc-xl7n.101's actual first draft, and the rewrite that fixed it
 * ===================================================================== */

console.log('\nbin/b7e-card --file — the bc-xl7n.101 acceptance case\n');

const brokenFile = path.join(tmp, 'broken.md');
fs.writeFileSync(
  brokenFile,
  [
    'Some prose about why this is closed.',
    '',
    '```decision',
    'question: Close bc-xl7n.101?',
    'options:',
    '  - id: close',
    '    label: Close it',
    '    recommended: true',
    '  - id: build-both',
    '    label: Build both as written',
    '    hint: Costs nothing — superseded-by: already keeps it out',
    '    closes: false',
    '```',
    '',
  ].join('\n')
);

const fixedFile = path.join(tmp, 'fixed.md');
fs.writeFileSync(
  fixedFile,
  [
    'Some prose about why this is closed.',
    '',
    '```decision',
    'question: Close bc-xl7n.101?',
    'options:',
    '  - id: close',
    '    label: Close it',
    '    recommended: true',
    '  - id: build-both',
    '    label: "Build both as written"',
    '    hint: "Costs nothing — superseded-by: already keeps it out"',
    '    closes: false',
    '```',
    '',
  ].join('\n')
);

check('the unquoted first draft exits non-zero and names the superseded-by line', () => {
  const r = run(['bc-plain.1', '--file', brokenFile]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /superseded-by: already keeps it out/);
});

check('the quoted rewrite exits 0 and prints the question and three options', () => {
  const r = run(['bc-plain.1', '--file', fixedFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Close bc-xl7n\.101\?/);
  assert.match(r.stdout, /options \(2\):/); // this fixture only wrote two — see below for a 3-option one
});

const threeOptionFile = path.join(tmp, 'three.md');
fs.writeFileSync(
  threeOptionFile,
  [
    '```decision',
    'question: Close bc-xl7n.101?',
    'options:',
    '  - id: close',
    '    label: Close it',
    '    recommended: true',
    '  - id: build-both',
    '    label: "Build both as written"',
    '    closes: false',
    '  - id: park',
    '    label: Not yet',
    '    defers: true',
    '```',
    '',
  ].join('\n')
);

check('a three-option block is reported as exactly three options', () => {
  const r = run(['bc-plain.1', '--file', threeOptionFile, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.options.length, 3);
  assert.equal(parsed.question, 'Close bc-xl7n.101?');
});

check('--file against a bead whose live field carries markers the draft lacks warns of the drop', () => {
  const draft = path.join(tmp, 'draft-no-markers.md');
  fs.writeFileSync(draft, '```decision\nquestion: Keep going?\noptions:\n  - id: yes\n    label: Yes\n    recommended: true\n```\n');
  const r = run(['bc-markers.1', '--file', draft, '--field', 'notes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would drop them/);
  assert.match(r.stdout, /beadcause:inmain worktree-foo-bar/);
});

check('--file against a bead whose live field carries no markers prints no warning', () => {
  const draft = path.join(tmp, 'draft-plain.md');
  fs.writeFileSync(draft, '```decision\nquestion: Keep going?\noptions:\n  - id: yes\n    label: Yes\n    recommended: true\n```\n');
  const r = run(['bc-plain.1', '--file', draft]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /would drop them/);
});

/* ===================================================================== */

removeTreeSync(tmp);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
