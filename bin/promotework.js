#!/usr/bin/env node
/**
 * What an epic's work actually was — the list a release agent tests in UAT.
 *
 *   beadcause-promotework -w beadcause -e bc-9d37      the epic
 *   beadcause-promotework -w beadcause -b bc-9d37.10   the promotion bead, which names it
 *   beadcause-promotework -w beadcause -e bc-9d37 --json
 *
 * ## Why this exists rather than a list in the bead
 *
 * A promotion bead (lib/promote.js) is filed once, when every bead an epic's plan named has
 * closed, and its body is written at that moment and never again. That is right for an epic
 * whose plan is its final word and wrong for the normal shape here: an advocate is
 * re-entered on child events precisely so it can file what the first plan missed, so the
 * epic goes on closing work for days afterwards. Measured on bc-9d37 — its promotion bead
 * named four beads, the epic closed nine, and the most visible behaviour change of the lot
 * was among the five that landed after the bead was written.
 *
 * The **image** promoted is right regardless; it is main's merge build and carries
 * everything. What goes stale is what the release agent is told to *exercise* — and a
 * promotion that tests the wrong things and passes is worse than one that fails. So one
 * place decides what an epic's work was, and it is the tracker, which cannot go stale. This
 * is that read, run at the moment somebody promotes rather than at the moment somebody
 * filed. bc-y8k4.1.
 *
 * Ship beads, promotion beads, containers and superseded ones are not work: nothing was
 * built for any of them, and a release agent sent to test one goes looking for a feature
 * that does not exist. They are printed under `not work`, with the label that excluded
 * them, because "where is bc-x" is the first question a derived list gets and a tool that
 * cannot answer it sends you back to reading labels by hand.
 *
 * **It over-includes on purpose, and on a busy epic that shows.** The only thing the tracker
 * offers to separate landed work from a card the daemon filed and Adam answered is a set of
 * labels, and there is no label that does it: bc-xl7n.15 ("#244 left 1 conflicting pull
 * request behind it") and bc-xl7n.35 ("a sweep card whose record is dropped can never
 * close") are both closed under bc-9d37 and both carry `inbox`, and only the second was
 * built. So bc-9d37 derives 27 rows where nine are the epic's work. That is the right way
 * to be wrong — the titles separate them in a glance, and the alternative is the failure
 * this exists to fix, which is silently testing four of nine and passing.
 *
 * Exit codes: 1 usage, 4 no such bead, 5 the tracker would not answer. A tracker that will
 * not answer is a refusal and not an empty list, for the reason everything else in this
 * daemon refuses on it — we-cannot-say settles nothing, and an empty UAT list that reads as
 * "nothing to test" is exactly the failure this tool was written for.
 */
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { landedWork } from '../lib/promote.js';
import { epicOf } from '../lib/promoterun.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const warn = (msg) => console.error(`beadcause-promotework: ${msg}`);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const given = arg('--epic', '-e') || arg('--bead', '-b');
const json = has('--json');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !given || has('--help') || has('-h')) {
  console.error('usage: beadcause-promotework -w <workspace> -e <epic> [--json]');
  console.error('       -b <promotion bead> works too — its title names the epic');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

// The same three the daemon builds it with, so a workspace on a Dolt server is reached the
// same way from a pipe as from the daemon itself.
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

let row;
try {
  row = await bd.show(ws, given);
} catch (err) {
  warn(`could not read ${given} — ${err.message.split('\n')[0]}`);
  process.exit(5);
}
if (!row) {
  warn(`${ws.name} has no bead ${given}`);
  process.exit(4);
}

/**
 * The epic, from whichever of the two ids you have.
 *
 * A release agent is handed the *promotion* bead, not the epic, and asking it to copy an id
 * out of a title is asking it to get that wrong once. The title is `Promote <epic> — …`,
 * written by `title()` in lib/promote.js, so the id is in a fixed place; a promotion bead
 * whose title somebody rewrote falls back to being treated as an epic, which fails with
 * "closed nothing" rather than with a wrong list.
 *
 * `epicOf` lives in lib/promoterun.js because the release agent needs the same read for the
 * same reason, off the same bead — and two hand-rolled copies of one regex is how the two
 * ends of a seam drift apart with both of them passing their own tests.
 */
const epicId = epicOf(row) || given;
if (epicId !== given) console.error(`# ${given} promotes ${epicId}`);

const work = await landedWork(bd, ws, epicId);
if (work.error) {
  warn(`could not read ${ws.name}'s shape, so what ${epicId} closed cannot be derived — ${work.error}`);
  process.exit(5);
}

// `process.exit(0)` right after the write below used to drop whatever of it was still
// pending: stdout to a pipe is async, so a big `--json | jq` run cut at the 64KB pipe
// buffer with a success status and no signal at all (bc-dgx7.45). Falling off the end
// with `process.exitCode` set instead — the `else` is what stands in for the early
// return `process.exit` used to give — flushes.
if (json) {
  console.log(JSON.stringify({ workspace: ws.name, epic: epicId, ...work }, null, 2));
  process.exitCode = 0;
} else {
  const n = work.beads.length;
  console.log(`${epicId} — ${n} work ${n === 1 ? 'bead' : 'beads'} closed, and this is the list to test`);
  for (const b of work.beads) console.log(`  ${b.id}  ${b.title}`);
  if (work.skipped.length) {
    console.log(`\nnot work (${work.skipped.length}) — closed under ${epicId}, nothing was built for them:`);
    for (const b of work.skipped) console.log(`  ${b.id}  [${b.why}]  ${b.title}`);
  }
  if (work.open.length) {
    // Not a failure of this tool: it is bc-4bet.2's defect showing up in the one place
    // somebody is still in a position to stop a release over it.
    console.log(`\nstill open (${work.open.length}) — ${epicId}'s work is not all in main:`);
    for (const b of work.open) console.log(`  ${b.id}  ${b.title}`);
  }
}
