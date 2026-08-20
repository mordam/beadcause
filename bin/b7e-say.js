#!/usr/bin/env node
/**
 * Agent prose goes into a bead or a memory from a file, never across a shell argument.
 *
 *   b7e-say -w beadcause -b bc-gdub --debrief <<'EOF'
 *   Whatever happened, however many backticks, $(...) or heredoc terminators it needs.
 *   EOF
 *
 *   b7e-say -w beadcause -b bc-gdub --note a-key-that-outlives-the-run <<'EOF'
 *   ...
 *   EOF
 *
 * **bc-gdub.2, filed by the session audit that found this workaround written by hand five
 * times.** `beadcause-memory debrief/note/remember`, `bin/checkin.js -m` and three of
 * `bin/deliver.js`'s flags (`--tests`/`--risk`/`--left`) all take the text a session wants
 * to say as a literal argv token — which forces a session to put backticked code examples
 * and multi-line prose directly inside a Bash tool call's double-quoted command string.
 * Bash resolves backticks inside double quotes as command substitution **before** the
 * command it is quoting ever runs, so `beadcause-memory debrief "...`git checkout foo`..."`
 * executes the checkout rather than describing it — twice, on two different beads
 * (bc-gdub, bc-ka5y.15.2), reverting real files the second time. `bin/file.js`,
 * `bin/supersede.js` and `bin/deliver.js`'s own `--file`/summary already dodge this —
 * `file ? fs.readFileSync(file) : fs.readFileSync(0)` — because a heredoc on stdin is
 * never re-scanned for shell expansions the way an inline double-quoted argument is. This
 * is that idiom, once, for the five call sites that were still missing it.
 *
 * Exactly one action, always with `-w` and `-b`:
 *
 *   --debrief                report on the run you are in, filed against the bead
 *   --note <key>              something about the repo you are standing in
 *   --remember <key>          something that should follow you into any repo
 *   --checkin                 "still working" — answers a check-in request in place
 *   --tests | --risk | --left   the same field a delivery's PR body carries, recorded as
 *                              a labelled comment on the bead so it exists even if the
 *                              `deliver.js` call that follows still has to pass it as argv
 *
 * The body is `--file <path>` or stdin — never a positional argument, so there is nothing
 * for a shell to re-parse. Empty is refused before anything is touched.
 *
 * `--note`/`--remember` key validation happens inside `lib/memory.js`'s `note`/`remember`
 * (letters/digits/dot/dash/underscore, 64 max) — that check runs synchronously before any
 * ref is read or written, so a key that is too long is refused *before* anything lands,
 * not after (bc-y8k4.4 hit this the hard way: a 68-character key rejected mid-flow rather
 * than up front).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { checkinFileFor } from '../lib/advocate.js';
import { writeJsonAtomic } from '../lib/atomic.js';
import { remember, note, debrief } from '../lib/memory.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);

const USAGE = `usage: b7e-say -w <workspace> -b <bead> --debrief [--file <path>]
       b7e-say -w <workspace> -b <bead> --note <key> [--file <path>]
       b7e-say -w <workspace> -b <bead> --remember <key> [--file <path>]
       b7e-say -w <workspace> -b <bead> --checkin [--file <path>]
       b7e-say -w <workspace> -b <bead> --tests|--risk|--left [--file <path>]

The body comes from --file <path> or stdin — never a shell argument, so backticks,
$(...), newlines and a heredoc terminator inside it are inert.`;

if (has('--help') || has('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const cfg = loadConfig();
const wsName = arg('-w', '--workspace');
const beadId = arg('-b', '--bead');
const file = arg('-f', '--file');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !beadId) {
  console.error(USAGE);
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

/**
 * Exactly one action. `note` and `remember` carry a key as the token right after the
 * flag — everything else is bare. Checked before the body is even read, so two actions
 * named at once (a typo, not a request to do both) costs nothing.
 */
const ACTIONS = ['debrief', 'note', 'remember', 'checkin', 'tests', 'risk', 'left'];
const present = ACTIONS.filter((a) => has(`--${a}`));
if (present.length !== 1) {
  console.error(
    present.length
      ? `b7e-say: pass exactly one action, not ${present.map((a) => `--${a}`).join(' and ')}`
      : 'b7e-say: pass exactly one action — --debrief, --note <key>, --remember <key>, --checkin, --tests, --risk or --left'
  );
  console.error(USAGE);
  process.exit(1);
}
const action = present[0];
const KEYED = new Set(['note', 'remember']);
const key = KEYED.has(action) ? arg(`--${action}`) : null;
if (KEYED.has(action) && !key) {
  console.error(`b7e-say: usage: b7e-say -w <workspace> -b <bead> --${action} <key> [--file <path>]`);
  process.exit(1);
}

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
const body = raw.trim();
if (!body) {
  console.error(`b7e-say: nothing to say — pipe text in or pass --file, ${beadId} was not touched`);
  process.exit(1);
}
const bytes = Buffer.byteLength(body, 'utf8');

// Who this is written as. `--agent` is for a human at a terminal; an agent session
// carries BEADCAUSE_AGENT already, exactly as bin/beadcause-memory reads it.
const who = String(arg('--agent') || process.env.BEADCAUSE_AGENT || '');
function me() {
  if (!who) throw new Error('no agent — set BEADCAUSE_AGENT or pass --agent <id>');
  return who;
}

async function main() {
  switch (action) {
    case 'debrief': {
      const r = await debrief(me(), beadId, body);
      console.log(`debriefed ${r.bead} (${r.entries} this run) in ${r.repo} — ${bytes} bytes`);
      return;
    }
    case 'note': {
      const r = await note(me(), key, body);
      console.log(`noted ${r.agent}.${r.key} in ${r.repo} — ${bytes} bytes`);
      return;
    }
    case 'remember': {
      const r = await remember(me(), key, body);
      console.log(`remembered ${r.agent}.${r.key} — ${bytes} bytes`);
      return;
    }
    case 'checkin': {
      // Unlike the memory tiers, a check-in is not attributed to an agent kind — it is
      // read back by workspace + issue id alone (lib/advocate.js), exactly as
      // bin/checkin.js already writes it.
      const target = checkinFileFor(ws.name, beadId);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeJsonAtomic(target, { at: new Date().toISOString(), note: body });
      console.log(`checked in on ${ws.name}/${beadId} — ${bytes} bytes`);
      return;
    }
    case 'tests':
    case 'risk':
    case 'left': {
      const label = { tests: 'Tests', risk: 'Worth knowing', left: 'Left undone' }[action];
      const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });
      await bd.comment(ws, beadId, `**${label}:** ${body}`);
      console.log(`commented ${label} on ${beadId} in ${ws.name} — ${bytes} bytes`);
      return;
    }
    default:
      // Unreachable — the ACTIONS guard above already refused anything else.
      throw new Error(`unknown action ${action}`);
  }
}

main().catch((err) => {
  console.error(`b7e-say: ${err.message}`);
  process.exit(1);
});
