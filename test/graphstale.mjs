#!/usr/bin/env node
/**
 * What `Bd.graph` hands back when the export it needed did not answer — bc-j52g.
 *
 *     npm test
 *     node test/graphstale.mjs
 *
 * The failure this file exists for was invisible by construction. `Bd.graph` is one
 * `bd export`, and an export that fails is answered with **the last good index**, which
 * is the right answer for everything drawing a screen: a workspace that lost one read has
 * not lost its P0s, and blanking the board would hide them until the next success. But
 * the stand-in used to arrive indistinguishable from a fresh reading and stamped
 * `at: Date.now()` on the way into the cache, and those two together are how a single
 * lost export became a minute of quietly answering from before it:
 *
 *  - **Nothing could tell it apart from a current one.** lib/adoptsweep.js already
 *    declines to plan against an index carrying `error`, for exactly this reason — a plan
 *    is `bd update --parent` writes, and an epic filed since the reading is simply absent
 *    from it. That guard never fired, because `error` is only ever set when a workspace
 *    has *never* been read; a workspace read successfully once and failing afterwards got
 *    the old rows with nothing on them.
 *  - **And the failed read reset the clock.** Sixty more seconds of the pre-failure graph
 *    served to every caller, `refresh: true` included — because a refresh joins whatever
 *    the cache last stored — with no retry inside the window.
 *
 * Together that is one run in four of test/adoptsweepreal.mjs on a loaded Mac: the sweep
 * planned nothing for an epic written two seconds earlier, applied nothing, refused
 * nothing, logged nothing, and the assertion read `children: []`.
 *
 * So: the stand-in says `stale`, keeps the previous entry's age rather than pretending to
 * be new, and the sweep skips a workspace it could not re-read and says so. `error` is
 * left alone — five other callers branch on it and mean *never read* by it.
 *
 * A real `execFile` against a real fake `bd`, the way test/bdtimeout.mjs does it: nothing
 * here touches a tracker, a bead or the network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { Bd, forgetParents } = await import(path.join(ROOT, 'lib', 'bd.js'));
const { sweepAdoptions } = await import(path.join(ROOT, 'lib', 'adoptsweep.js'));

let failures = 0;
let ran = 0;
const check = (name, cond, detail = '') => {
  ran += 1;
  if (cond) return console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-graphstale-'));
const tally = path.join(tmp, 'calls');
const calls = () => (fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').length : 0);

/** Two rows, one of them an epic with a list — enough for `indexFrom` to build all four maps. */
const ROWS = [
  JSON.stringify({ id: 'xx-epic', title: 'an epic with a list', issue_type: 'epic', status: 'open', description: 'Adopts: xx-work.' }),
  JSON.stringify({ id: 'xx-work', title: 'the work', issue_type: 'task', status: 'open' }),
].join('\n');

/**
 * A `bd` that answers the first export and then stops answering.
 *
 * The failure is deliberately *not* a lock: `run` retries those, and what is under test
 * here is what one settled failure produces rather than how many times it is asked.
 */
const bin = path.join(tmp, 'bd-then-fails');
fs.writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require('node:fs');
const tally = ${JSON.stringify(tally)};
const before = fs.existsSync(tally) ? fs.readFileSync(tally, 'utf8').length : 0;
fs.appendFileSync(tally, 'x');
if (before === 0) { process.stdout.write(${JSON.stringify(ROWS)}); process.exit(0); }
process.stderr.write('bd: could not open the tracker');
process.exit(1);
`,
  { mode: 0o755 }
);

const bd = new Bd({ bin, actor: 'beadcause-test' });
const ws = { name: 'graphstale', dir: tmp };

console.log('\nthe shape of a workspace whose export stopped answering\n');

const first = await bd.graph(ws, { refresh: true });
check(
  'the reading that worked is an ordinary index, with no marker on it at all',
  first.beads.size === 2 && first.adopts.get('xx-epic')?.[0] === 'xx-work' && !first.error && !first.stale,
  `beads=${first.beads.size} adopts=${JSON.stringify([...first.adopts])} error=${first.error || ''} stale=${first.stale || ''}`
);

const afterOne = calls();
const stale = await bd.graph(ws, { refresh: true });

check(
  'a refresh that failed still hands back the last good rows, because a stale reading is still a reading',
  stale.beads.size === 2 && stale.beads.get('xx-work')?.title === 'the work',
  `beads=${stale.beads.size}`
);

check(
  'and it says so — `stale` carries the sentence bd failed with',
  typeof stale.stale === 'string' && /could not open the tracker/.test(stale.stale),
  `stale=${JSON.stringify(stale.stale)}`
);

check(
  'and it is not `error`, which five callers read as "this workspace has never been read"',
  stale.error === undefined,
  `error=${JSON.stringify(stale.error)}`
);

const afterTwo = calls();
check('the failed refresh really did spawn an export', afterTwo > afterOne, `${afterOne} → ${afterTwo}`);

// The half that used to hide the failure for a further minute. Asked of the source and not
// of the clock on purpose: the only observable difference is at the far end of a sixty-
// second window, and a suite that waited one out to prove it would be the slowest file in
// the repo for a single assertion. What is pinned is the decision — the entry it fell back
// on keeps its own age, so a read that failed cannot push the next re-export a minute away.
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bd.js'), 'utf8');
check(
  'and the cache entry it fell back on keeps its own age rather than being stamped fresh',
  /at:\s*hit\.at/.test(SRC),
  'lib/bd.js no longer carries the previous entry\'s `at` into the fallback — a failed export renews the window again'
);

/* --------------------------------- and a workspace that was never read at all is different */

forgetParents(ws.name);
const never = await bd.graph(ws, { refresh: true });
check(
  'a workspace with no good reading behind it is empty and carries `error`, unchanged',
  never.beads.size === 0 && typeof never.error === 'string' && never.stale === undefined,
  `beads=${never.beads.size} error=${JSON.stringify(never.error)} stale=${JSON.stringify(never.stale)}`
);

/* ------------------------------------------------- what the adoption sweep does with one */

console.log('\nand what the sweep plans against it\n');

const swept = async (index) => {
  const said = [];
  const wrote = [];
  const fake = {
    graph: async () => index,
    adopt: async (_w, bead, epic) => wrote.push(`${epic}→${bead}`),
    dropDep: async () => {},
  };
  const out = await sweepAdoptions(fake, [{ name: 'graphstale', dir: tmp }], { onLog: (l) => said.push(l) });
  return { out, said, wrote };
};

{
  const { out, wrote } = await swept(first);
  check(
    'a current reading is planned against as it always was — the epic adopts its bead',
    wrote.join() === 'xx-epic→xx-work' && out.applied.length === 1,
    `wrote=${JSON.stringify(wrote)} out=${JSON.stringify(out)}`
  );
}

{
  const { out, said, wrote } = await swept({ ...first, stale: 'bd: could not open the tracker' });
  check(
    'a stale one is not: nothing is written off a graph that predates what is being asked about',
    wrote.length === 0 && out.applied.length === 0 && out.refused.length === 0,
    `wrote=${JSON.stringify(wrote)} out=${JSON.stringify(out)}`
  );
  check(
    'and the sweep says why it did nothing, which is the whole difference from a quiet tick',
    said.some((l) => /not planning against graphstale/.test(l) && /could not open the tracker/.test(l)),
    JSON.stringify(said)
  );
}

{
  const { said, wrote } = await swept({ parents: new Map(), beads: new Map(), adopts: new Map(), edges: new Map(), error: 'timed out' });
  check(
    'and a workspace that was never read is skipped too, and now says that as well',
    wrote.length === 0 && said.some((l) => /never been read/.test(l)),
    JSON.stringify(said)
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
forgetParents(ws.name);

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
