#!/usr/bin/env node
/**
 * `beadcause-promoterun` — carry one promotion bead, by hand, against a real driver.
 *
 * bc-7qo.14. `lib/promoterun.js` landed `carry()` and `openPromotions()` under bc-y8k4.2,
 * and until this file the only caller anywhere in the repo was test/promoterun.mjs, against
 * a fake. This is the caller: the one-at-a-time, human-triggered shape the bead itself asks
 * for first, which suits a first production promotion far better than an unattended sweep
 * would.
 *
 *   beadcause-promoterun -w beadcause -b bc-9d37.10 --driver ./azure-driver.mjs
 *   beadcause-promoterun -w beadcause -b bc-9d37.10 --driver ./azure-driver.mjs --json
 *
 * ## Why `--driver` is a path and not a name
 *
 * `carry()` is written against a **driver interface** — four calls, `deployToUat`,
 * `testInUat`, `promoteToProd`, `testInProd` — precisely so this file does not need to know
 * what a pipeline is. bc-y8k4.3 (the Azure DevOps driver) is the thing meant to fill that
 * interface for Climative's pipelines, and **it has not landed** — grepping the whole repo
 * for any of the four call names outside lib/promoterun.js and its own test finds nothing.
 * So there is no default this file could pick for you, and pretending otherwise — a
 * `--pipeline azure` flag wired to code that is not there — would be a CLI that looks
 * finished and refuses every real bead. `--driver` takes a path to a module that exports the
 * four calls (as its default export or as named exports), dynamically imported, so this file
 * carries a bead against *whichever* driver a workspace has ready, real or otherwise, and
 * needs no change on the day bc-y8k4.3 lands.
 *
 * ## What this does not do
 *
 * It does not sweep. `openPromotions()` finds every endorsed promotion bead in a workspace,
 * and nothing here loops over that list on a timer — seed in lib/server.js's `cycle()`,
 * beside `sweepRelease`, is where that would go, gated the same two ways the bead names:
 * the endorsement hold `carry()` already refuses without (`isEndorsed`), and the per-space
 * `autoShip` switch (`lib/spaces.js`) that decides whether a workspace's deploys are allowed
 * to run unattended at all. Wiring it now, with no real driver to hand it and no workspace
 * that has said yes to unattended production promotion, would be a sweep that always finds
 * a bead and never has anything to carry it with — infrastructure with nothing to prove it
 * against. Deferred on purpose; see the README section this file is documented under.
 *
 * Exit codes: 1 usage, 2 the driver module would not load or is missing a call, 3 `carry`
 * refused before touching production (not a promotion bead, already closed, unendorsed, held
 * by somebody else, an epic or repo list that cannot be derived, a tracker that would not
 * answer), 4 it ran but did not close (still owed, cannot-say, or failed — see the printed
 * record for which), 0 every repo it names is promoted and verified.
 */
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { carry, record } from '../lib/promoterun.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const warn = (msg) => console.error(`beadcause-promoterun: ${msg}`);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const bead = arg('--bead', '-b');
const driverArg = arg('--driver', '-d');
const json = has('--json');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !bead || !driverArg || has('--help') || has('-h')) {
  console.error('usage: beadcause-promoterun -w <workspace> -b <promotion bead> --driver <path/to/driver.mjs> [--json]');
  console.error('  the driver module must export deployToUat, testInUat, promoteToProd and testInProd —');
  console.error('  as its default export or as named exports. Nothing in this repo supplies one yet:');
  console.error('  bc-y8k4.3 (the Azure DevOps driver) is still open.');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

let driverMod;
try {
  driverMod = await import(path.resolve(process.cwd(), driverArg));
} catch (err) {
  warn(`could not load driver ${driverArg} — ${err.message.split('\n')[0]}`);
  process.exit(2);
}
const driver = driverMod.driver || driverMod.default || driverMod;

// The same three the daemon builds a `Bd` with, so a workspace on a Dolt server is reached
// the same way from this pipe as from the daemon itself. See bin/promotework.js.
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

const run = await carry(bd, ws, bead, driver, { actor: cfg.actor });

if (run.refused) {
  warn(run.refused);
  process.exit(run.refused.startsWith('this driver cannot carry') ? 2 : 3);
}

if (json) {
  console.log(JSON.stringify(run, null, 2));
} else {
  console.log(record(run));
}
process.exit(run.closed ? 0 : 4);
