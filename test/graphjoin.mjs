#!/usr/bin/env node
/**
 * `Bd.graph({ refresh: true })` while an export is already running — bc-4m2j.7.
 *
 *     npm test
 *     node test/graphjoin.mjs
 *
 * `graph` de-duplicates concurrent exports through `PARENT_INFLIGHT`, keyed by
 * workspace, and the de-duplication used to be checked *before* `refresh` was honoured:
 * a second caller asking for a refresh while the first export for that key was still
 * running was simply handed the first export's promise. Every `refresh: true` in the
 * daemon exists because the caller just wrote something — `adopt`, `setStatus`,
 * `sweepAdoptions`'s own tail — and on a 30-second poll across nine workspaces there is
 * often already an export in flight for the key it cares about. Joining that export's
 * answer can hand the caller a reading taken *before* its own write, which defeats the
 * whole reason `refresh: true` was asked for.
 *
 * The fix is a chain rather than a join: a `refresh: true` that finds a job already in
 * `PARENT_INFLIGHT` starts a fresh export queued to run once that one settles, and it is
 * the chained job — not the one already running — that both the caller and the map get.
 *
 * A real `execFile` against a real fake `bd`, the way test/graphstale.mjs does it: the
 * fake `bd` answers its first invocation slowly (a real `sleep`, so the two exports are
 * provably serialized rather than merely promised to be) and every invocation after that
 * immediately, each one distinguishable by which call number produced it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { Bd } = await import(path.join(ROOT, 'lib', 'bd.js'));

let failures = 0;
let ran = 0;
const check = (name, cond, detail = '') => {
  ran += 1;
  if (cond) return console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-graphjoin-'));
const tally = path.join(tmp, 'calls');
const calls = () => (fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').length : 0);

/**
 * A `bd` whose first export sleeps before answering — a real Dolt call already in
 * flight — and answers every export after that at once, each one carrying which call
 * produced it so the test can tell whether a second caller got handed the first
 * export's answer or a fresh one of its own.
 */
const bin = path.join(tmp, 'bd-slow-then-fast');
fs.writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const tally = ${JSON.stringify(tally)};
const before = fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').length : 0;
fs.appendFileSync(tally, 'x');
const call = before + 1;
if (call === 1) execSync('sleep 0.3');
process.stdout.write(JSON.stringify({ id: 'xx-work', title: 'call ' + call, issue_type: 'task', status: 'open' }) + '\\n');
`,
  { mode: 0o755 }
);

const bd = new Bd({ bin, actor: 'beadcause-test' });
const ws = { name: 'graphjoin', dir: tmp };

console.log('\na refresh that overlaps an export already in flight\n');

// The first caller starts an export — call 1, which sleeps before answering, standing in
// for a real Dolt export that has not returned yet. `graph` registers this as the
// in-flight job for the key synchronously, before either promise below is awaited.
const first = bd.graph(ws, { refresh: true });

// A second caller asks for a refresh while that export is still running — the shape every
// one of `adopt`, `setStatus` and `sweepAdoptions`'s tail is in, on a loaded poll.
const second = bd.graph(ws, { refresh: true });

const [firstIndex, secondIndex] = await Promise.all([first, second]);

check(
  'bd was actually asked twice, not once — the second refresh did not just wait out the first',
  calls() === 2,
  `bd was invoked ${calls()} time(s)`
);

check(
  'the first caller gets the export that was already running',
  firstIndex.beads.get('xx-work')?.title === 'call 1',
  `title=${JSON.stringify(firstIndex.beads.get('xx-work')?.title)}`
);

check(
  "the second caller does not get handed the first export's answer — it gets its own",
  secondIndex.beads.get('xx-work')?.title === 'call 2',
  `title=${JSON.stringify(secondIndex.beads.get('xx-work')?.title)}`
);

check(
  'and the two calls really did resolve to different index objects',
  firstIndex !== secondIndex,
  'the second call returned the exact same object as the first — it joined rather than chained'
);

/* --------------------------------------- a plain refresh with nothing else running */

const beforeAlone = calls();
const alone = await bd.graph(ws, { refresh: true });
check(
  'a refresh with no export already in flight costs exactly one export, not a chain',
  calls() === beforeAlone + 1,
  `expected one export, saw ${calls() - beforeAlone}`
);
check(
  'and answers with that one export\'s own reading',
  alone.beads.get('xx-work')?.title === `call ${calls()}`,
  `title=${JSON.stringify(alone.beads.get('xx-work')?.title)}`
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
