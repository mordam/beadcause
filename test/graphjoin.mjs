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

/* ------------------------------------------------------------ who paid, and who waited */

/**
 * bc-1kwl.34 — a plain (non-`refresh`) join, and what each caller's timing record says.
 *
 * `PARENT_INFLIGHT` above is exactly the single-flight map lib/cache.js's `running` is
 * for the cold path, and a caller that finds a job already there and *joins* it (every
 * case except `refresh: true`, which chains rather than joins — see above) spawns
 * nothing of its own. Without `timing.joining()` beside `PARENT_INFLIGHT.get(key)`, that
 * caller comes back `no subprocess, all ours`, the same false reading bc-1kwl.33 fixed
 * for lib/cache.js's `running` map. The pair here mirrors test/cache.mjs's: one reader
 * starts the export, one joins it, and the assertions are that the starter still owns
 * the child and the joiner's record names the wait instead of hiding it as idle time.
 */
console.log('\nwhat a request that joins a bd export already in flight is filed as\n');

{
  const timing = await import('../lib/timing.js');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-graphjoin2-'));
  const tally2 = path.join(tmp2, 'calls');
  const calls2 = () => (fs.existsSync(tally2) ? fs.readFileSync(tally2, 'utf8').length : 0);

  const bin2 = path.join(tmp2, 'bd-slow-then-fast');
  fs.writeFileSync(
    bin2,
    `#!/usr/bin/env node
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const tally = ${JSON.stringify(tally2)};
const before = fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').length : 0;
fs.appendFileSync(tally, 'x');
const call = before + 1;
if (call === 1) execSync('sleep 0.3');
process.stdout.write(JSON.stringify({ id: 'xx-work', title: 'call ' + call, issue_type: 'task', status: 'open' }) + '\\n');
`,
    { mode: 0o755 }
  );

  const bd2 = new Bd({ bin: bin2, actor: 'beadcause-test' });
  const ws2 = { name: 'graphjoin2', dir: tmp2 };

  // A fresh async resource per request, the way test/cache.mjs's `inRequest` isolates
  // one `timing.begin` from another — `enterWith` persists for the rest of the resource
  // it is called on, so two records opened side by side in this file's top-level context
  // would silently be the same record.
  const inRequest = (key, fn) =>
    new Promise((resolve, reject) => {
      setImmediate(() => {
        const rec = timing.begin(key);
        Promise.resolve()
          .then(fn)
          .then(
            (value) => resolve({ closed: timing.end(rec, 200), value }),
            (err) => {
              timing.end(rec, 500);
              reject(err);
            }
          );
      });
    });

  timing.reset();
  timing.configure({ slowMs: 1000 });

  const starter = inRequest('GET /api/beads', () => bd2.graph(ws2));
  // Long enough for `graph`'s synchronous `PARENT_INFLIGHT.set` to have already happened
  // inside the starter's export — the same margin test/cache.mjs gives its own join.
  await new Promise((r) => setTimeout(r, 10));
  const joiner = inRequest('GET /api/prs', () => bd2.graph(ws2));

  const first = await starter;
  const second = await joiner;

  check('two joined readers of one workspace still produce one export', calls2() === 1, `bd was invoked ${calls2()} time(s)`);
  check(
    'and the joiner gets exactly the index the starter got — a join, not a chain',
    second.value === first.value,
    'the joiner resolved to a different index object than the starter'
  );

  check('the reader that started the export is charged its child process', first.closed.wallMs > 0, `wallMs ${first.closed.wallMs}`);
  check('and nothing as a wait, because it was not waiting on anybody', first.closed.joinedMs === 0, `joinedMs ${first.closed.joinedMs}`);

  check('the reader that joined is charged no child process — the export was not its fan-out', second.closed.wallMs === 0, `wallMs ${second.closed.wallMs}`);
  check(
    'and the wait is recorded as its own figure instead of vanishing into idle time',
    second.closed.joinedMs > 0,
    `joinedMs ${second.closed.joinedMs}`
  );

  const rows = timing.snapshot().routes;
  check(
    'the joining route counts the join, which is what keeps it out of `starved`',
    rows.find((r) => r.route === 'GET /api/prs')?.joins === 1,
    `joins=${rows.find((r) => r.route === 'GET /api/prs')?.joins}`
  );
  check(
    "and the starting route's own record carries none",
    rows.find((r) => r.route === 'GET /api/beads')?.joins === 0,
    `joins=${rows.find((r) => r.route === 'GET /api/beads')?.joins}`
  );

  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
