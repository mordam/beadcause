#!/usr/bin/env node
/**
 * `N closed` on the advocate console — the one number on that row that is finished work.
 *
 *     npm test
 *     node test/closedpill.mjs
 *
 * Every other pill on a repo's row is work outstanding: open, ready, blocked, in
 * progress, and the nine ways the advocate holds a bead back. There was no number
 * anywhere on that card for what had been *done*, over a tracker where beadcause alone
 * has closed nearly six hundred beads and the close reasons are the best record of what
 * shipped that this repo has.
 *
 * The pill was designed on `origin/worktree-closed-history-qsj6` against a closed-only
 * page that no longer exists — bc-qsj6 was closed as a duplicate of bc-nib3 and the
 * ledger landed instead — so this is the transplant of the one part of that branch that
 * outlived it (bc-1sj4), and the two claims it rests on are what this suite checks.
 *
 * 1. **It is free.** `bd status` has carried `closed_issues` since long before this row
 *    existed and `forWorkspace` has always read that summary, so the count costs no
 *    fourth `bd` invocation on a card that repaints every twenty seconds. That is a
 *    claim about argv rather than about the code, so `bd` here is a stub binary that
 *    logs every call it is given and the suite counts them.
 * 2. **It is drawn from that field or not at all.** A `bd` too old to report the number
 *    must leave the pill off rather than draw `0 closed`, which would state as a fact
 *    that a repo has finished nothing; and a workspace whose tracker fell over must not
 *    acquire a nought on the way through the error path.
 *
 * The page half is a source read, like `test/closeview.mjs` and the monitor assertions
 * in `test/autoendorse.mjs`: what matters about the pill is which field it reads, where
 * it goes, and that it is *last* in the row — it is the only entry there that is not
 * something still to do, and beside `open` it reads as one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-closedpill-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { Bd } = await import(LIB('bd.js'));
const { collectWork } = await import(LIB('work.js'));

/* ------------------------------------------------------------------- the stub bd */

const WORLD = path.join(tmp, 'world.json');
const BD_LOG = path.join(tmp, 'bd-calls.log');
const FAKE_BD = path.join(tmp, 'bd');

/**
 * A tracker in a JSON file, keyed by workspace directory — `BEADS_DIR` is how `Bd.run`
 * says which workspace it means, so the stub resolves the same way bd itself does.
 *
 * Every call is appended to `BD_LOG` before anything is answered, including the ones
 * that go on to fail, because the claim under test is how many calls are made and not
 * how many succeeded. The summary is written into the world file rather than computed,
 * so a `bd` that has never heard of `closed_issues` is one workspace's data rather than
 * a second stub binary.
 */
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.BEADS_DIR || '';
fs.appendFileSync(${JSON.stringify(BD_LOG)}, JSON.stringify([dir, ...args]) + '\\n');
const world = JSON.parse(fs.readFileSync(${JSON.stringify(WORLD)}, 'utf8'));
const w = world[dir];
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (!w) die('no beads database found in ' + dir);
if (w.broken) die('Error: dolt: could not open database');
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ summary: w.summary })); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

const bdCalls = () =>
  fs.existsSync(BD_LOG) ? fs.readFileSync(BD_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const clearCalls = () => fs.rmSync(BD_LOG, { force: true });

const spaceDir = (name) => path.join(tmp, 'ws', name, '.beads');
const workspace = (name) => ({ name, dir: spaceDir(name) });
for (const name of ['alpha', 'ancient', 'broken']) fs.mkdirSync(spaceDir(name), { recursive: true });

fs.writeFileSync(
  WORLD,
  JSON.stringify(
    {
      [spaceDir('alpha')]: {
        summary: {
          open_issues: 7,
          ready_issues: 3,
          blocked_issues: 1,
          in_progress_issues: 2,
          closed_issues: 586,
        },
      },
      // The same tracker as it was before `bd status` grew the field. Nothing in the app
      // pins a bd version, and this row is the reason the count is `?? null`.
      [spaceDir('ancient')]: {
        summary: { open_issues: 7, ready_issues: 3, blocked_issues: 1, in_progress_issues: 2 },
      },
      [spaceDir('broken')]: { broken: true },
    },
    null,
    2
  )
);

const bd = new Bd({ bin: FAKE_BD, actor: 'beadcause-test' });

/* --------------------------------------------------------------------- harness */

let ran = 0;
let failures = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
};

/* ---------------------------------------------------- the count, and what it cost */

await check('the console carries the tracker’s own closed count, verbatim', async () => {
  const rows = await collectWork(bd, [workspace('alpha')], {}, []);
  assert.equal(rows[0].counts.closed, 586, 'the pill is drawn from this and from nothing else');
});

await check('and it costs no `bd` call that was not already being made', async () => {
  clearCalls();
  await collectWork(bd, [workspace('alpha')], {}, []);
  const verbs = bdCalls()
    .map((c) => c[1])
    .sort();
  // The calls `forWorkspace` makes, and **none of them is this pill's**: `closed_issues`
  // rides on the `status` summary the row was already reading. That is the whole
  // objection this check exists to hold — the advocate console repaints every twenty
  // seconds across every workspace at once, so a `bd` call added to this row is added to
  // all of them forever, and a pill costing one would not be worth it.
  //
  // Two `ready` calls rather than one since lib/shipbead.js: the held beads and the ship
  // beads, which have to be counted apart because they only partly overlap and both come
  // out of `ready`. Asserted as the exact multiset so that a *third* one still fails
  // here — the point was never the number three, it was that nothing is added lightly.
  assert.deepEqual(verbs, ['list', 'ready', 'ready', 'status'], `got ${JSON.stringify(bdCalls())}`);
});

await check('a bd too old to report it draws no pill, rather than claiming nothing is done', async () => {
  const rows = await collectWork(bd, [workspace('ancient')], {}, []);
  assert.equal(rows[0].counts.closed, null, '`?? null`, not `?? 0` — `0 closed` is a claim');
  assert.equal(rows[0].counts.open, 7, 'and the rest of the row is unaffected');
});

await check('a workspace whose tracker fell over gets no count at all', async () => {
  const rows = await collectWork(bd, [workspace('broken')], {}, []);
  assert.ok(rows[0].error, 'the row still reports, which is the point of the error path');
  assert.equal(rows[0].counts.closed, undefined, 'a nought here would be a number nobody counted');
});

/* --------------------------------------------------------------------- the page */

await check('the page draws it from that field, and takes you to the ledger', () => {
  const js = read('public/monitor.js');
  assert.ok(/c\.closed/.test(js), 'nothing on the row reads the count');
  assert.ok(/\$\{c\.closed\} closed<\/a>/.test(js), 'the pill is not a link, so the number is still a dead end');
  assert.ok(/href="\/history"/.test(js), 'and it does not go to the history ledger');
});

await check('and it is last, because it is the only pill there that is not work outstanding', () => {
  const js = read('public/monitor.js');
  const domain = js.slice(js.indexOf('function domainHtml'), js.indexOf('<div class="mon-domain">'));
  const closed = domain.indexOf('c.closed');
  assert.ok(closed > 0, 'the pill is not in domainHtml at all');
  for (const before of ['c.open != null', 'c.held ?', 'busyFiles.length']) {
    assert.ok(domain.indexOf(before) < closed, `${before} is drawn after the closed count`);
  }
});

console.log(`\n${ran - failures}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
