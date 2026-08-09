#!/usr/bin/env node
//
// Does a state file survive a writer being killed mid-write?
//
//   npm test                        (runs it alongside test/observe.mjs)
//   node test/atomic.mjs --baseline  (the proof that a pass means something)
//
// The failure this guards against is not subtle once you have seen it: a bare
// `fs.writeFileSync` truncates before it writes, so a process killed inside that
// window leaves a zero-length or half-written file, and every reader in this repo
// treats an unparseable state file as an empty one. You lose the whole file, and
// nothing says so.
//
// So this drives the real `lib/atomic.js` in a child process that is SIGKILLed
// while it writes, repeatedly, and asserts the file on disk is always one of the
// two whole versions — never a torn one. `--baseline` runs the same torture
// against a plain `writeFileSync` instead, which is how you check that a pass here
// is real: baseline must tear, the working copy must not.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, writeJsonAtomic } from '../lib/atomic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = process.argv.includes('--baseline');

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-atomic-'));
process.on('exit', () => fs.rmSync(tmpdir, { recursive: true, force: true }));

/* ------------------------------------------------------- the ordinary cases */

console.log('writes');

const target = path.join(tmpdir, 'state.json');
writeJsonAtomic(target, { notified: ['a', 'b'] });
check('creates the file', fs.existsSync(target));
check(
  'bytes are what writeFileSync produced before',
  fs.readFileSync(target, 'utf8') === JSON.stringify({ notified: ['a', 'b'] }, null, 2) + '\n',
  JSON.stringify(fs.readFileSync(target, 'utf8'))
);
check('mode is 0o600', (fs.statSync(target).mode & 0o777) === 0o600, (fs.statSync(target).mode & 0o777).toString(8));

writeJsonAtomic(target, { notified: ['c'] });
check('replaces an existing file', JSON.parse(fs.readFileSync(target, 'utf8')).notified.length === 1);
check(
  'mode survives the replace',
  (fs.statSync(target).mode & 0o777) === 0o600,
  (fs.statSync(target).mode & 0o777).toString(8)
);

// The daemon and a `npm run configure` run share config.json. If they shared a
// temp name, one would rename the other's half-written file into place — the
// corruption this module exists to prevent, reintroduced.
const shared = path.join(tmpdir, 'shared.json');
const before = fs.readdirSync(tmpdir).length;
writeFileAtomic(shared, 'one');
writeFileAtomic(shared, 'two');
check('leaves no temp file behind', fs.readdirSync(tmpdir).length === before + 1, fs.readdirSync(tmpdir).join(' '));

// A write that cannot land must not take anything with it, and must not report
// success — a silently swallowed failure is how state goes missing unnoticed.
const kept = path.join(tmpdir, 'kept.json');
writeJsonAtomic(kept, { good: true });
let threw = false;
try {
  writeJsonAtomic(path.join(tmpdir, 'nope', 'x.json'), { bad: true });
} catch {
  threw = true;
}
check('a write that cannot land throws', threw);
check('a failed write leaves other state alone', JSON.parse(fs.readFileSync(kept, 'utf8')).good === true);

/* ------------------------------------------------------------- the torture */

// A child that rewrites one file in a loop, alternating between two whole
// versions, until it is killed. Both versions are large enough that a truncating
// write is unlikely to complete inside one scheduler slice — which is what makes
// the baseline actually tear rather than passing by luck.
const victim = path.join(tmpdir, 'victim.json');
const A = JSON.stringify({ v: 'A', pad: 'a'.repeat(400000) });
const B = JSON.stringify({ v: 'B', pad: 'b'.repeat(400000) });

const childSrc = path.join(tmpdir, 'writer.mjs');
fs.writeFileSync(
  childSrc,
  [
    `import fs from 'node:fs';`,
    `import { writeFileAtomic } from ${JSON.stringify(path.join(ROOT, 'lib', 'atomic.js'))};`,
    `const file = ${JSON.stringify(victim)};`,
    `const baseline = ${JSON.stringify(BASELINE)};`,
    `const A = ${JSON.stringify(A)};`,
    `const B = ${JSON.stringify(B)};`,
    `let i = 0;`,
    `process.send('ready');`,
    `for (;;) {`,
    `  const data = i++ % 2 ? A : B;`,
    `  if (baseline) fs.writeFileSync(file, data, { mode: 0o600 });`,
    `  else writeFileAtomic(file, data);`,
    `}`,
    '',
  ].join('\n')
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function torture(round) {
  const child = spawn(process.execPath, [childSrc], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((r) => child.once('message', r));
  // Long enough that the loop is mid-write, varied so we sample different points
  // of it across rounds rather than hitting the same instant every time.
  await sleep(20 + round * 7);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  if (!fs.existsSync(victim)) return null; // killed before the first write landed
  const raw = fs.readFileSync(victim, 'utf8');
  return raw === A ? 'A' : raw === B ? 'B' : `torn (${raw.length} bytes)`;
}

console.log(`\nkill -9 mid-write  (${BASELINE ? 'baseline: plain writeFileSync' : 'lib/atomic.js'})`);

const torn = [];
let sampled = 0;
for (let round = 0; round < 12; round++) {
  const state = await torture(round);
  fs.rmSync(victim, { force: true });
  if (state === null) continue;
  sampled += 1;
  if (state !== 'A' && state !== 'B') torn.push(`round ${round}: ${state}`);
}

check('the writer was caught mid-write often enough to mean something', sampled >= 8, `only ${sampled}/12 rounds wrote anything`);
check(
  'every survivor is a whole version, never a torn one',
  torn.length === 0,
  `${torn.length}/${sampled} rounds left a torn file — ${torn.slice(0, 3).join('; ')}`
);

/* ------------------------------------------------------------------ verdict */

console.log('');
if (BASELINE) {
  // Inverted on purpose: the baseline run exists to prove the torture has teeth.
  if (torn.length) {
    console.log(`baseline tore ${torn.length}/${sampled} rounds, as it should — the check is meaningful.`);
    process.exit(0);
  }
  console.log('baseline did NOT tear, so the torture is not reproducing the bug and a pass proves nothing.');
  process.exit(1);
}
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all checks passed');
