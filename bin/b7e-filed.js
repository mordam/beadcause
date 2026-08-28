#!/usr/bin/env node
/**
 * `b7e-filed` — confirm a filing batch actually landed: ids, parents, whole descriptions.
 *
 *     b7e-filed -w beadcause --from bc-dgx7 -f beads.yaml
 *     b7e-filed -w beadcause --from bc-dgx7 --repair < beads.yaml
 *     b7e-filed -w beadcause --from bc-dgx7 --json -f beads.yaml
 *
 * bc-dgx7.104: three sessions (dv-afr.6, dv-afr.7, dv-afr.8) filed beads through
 * `bin/file.js`, could not tell whether the filing had landed, and each invented its
 * own recovery — one polled a pid for twelve minutes, one repaired a missing parent by
 * hand and confirmed it with `bd list --parent=X | tail -12`, one got no output at all
 * on a call that had in fact filed and nearly double-filed the batch. This takes the
 * same YAML spec that was piped to `bin/file.js`, plus `--from`, and answers all three
 * questions in one call: did every title land, did it land exactly once, did it land
 * with its parent, and did its description arrive whole.
 *
 * **How a bead is found, and why by label rather than by title search.** Every bead
 * `lib/filing.js` successfully creates carries `filed-while:<from>` — written
 * unconditionally, whatever else happens to it — so `bd list --label filed-while:<from>`
 * (all statuses, including closed) is the exhaustive and exact set of beads this `from`
 * has ever filed. A title is then matched against that set, not against the whole
 * tracker: a bare title search would have to guess at bd's own ranking and could not
 * tell "this title exists elsewhere in the tracker" apart from "this filing produced a
 * duplicate", which is the one distinction this command exists to make.
 *
 * A title from the spec with **no** match in that set is `unfiled` — the create never
 * landed, or landed under a title bd normalised differently, and either way it is not
 * safe to assume filed. **More than one** match is `duplicate` — the same title was
 * filed twice under this `from`, exactly the dv-afr.8 shape ("SEARCH BY TITLE before
 * re-running or you double-file"). **Exactly one** match is `filed`, and only then is
 * there a bead to check the rest of.
 *
 * **The description check is a byte count, not a diff.** The expected body is what
 * `lib/filing.js#beadToIssue` would have built — the spec's `description`, with the
 * `files:` block folded in via `lib/beadfiles.js#withSurface` when the spec named any —
 * compared by UTF-8 byte length against what the bead's `description` field actually
 * holds. A byte count catches the dv-afr.6 shape (an apostrophe broke file.js's shell
 * quoting and truncated the description partway through) without needing to reproduce
 * bd's own formatting exactly.
 *
 * **`--repair` re-attaches a missing parent, and nothing else.** `lib/homing.js#homeIn`
 * is asked the same question `fileBeads` asked at filing time — where does a bead
 * discovered from `--from` belong — and a bead that is missing a parent AND is not
 * itself root-shaped (`lib/ownership.js#isRoot`) AND has somewhere to go is adopted
 * there with `bd update <id> --parent=<home>`, the exact repair dv-afr.7 did by hand
 * (`bd update dv-imex --parent=dv-afr`). It only ever attaches an *absent* parent —
 * a bead already adopted somewhere on purpose is left alone, because "move it if it
 * belongs somewhere better" (lib/filing.js's own provenance note) is Adam's call, not
 * this command's.
 *
 * Exit codes: `0` every title filed exactly once, with a parent (or root-shaped /
 * nowhere to hang one), description whole. `1` at least one title is `unfiled`,
 * `duplicate`, missing a parent it was not repaired into, or arrived truncated. `2` bad
 * usage. `3` the YAML names no beads. `4` `-w`/`--from` named something this checkout's
 * tracker does not have.
 *
 * **Read-only unless `--repair` is passed, and this is deliberately not on
 * `DEFAULT_TOOL_LIST` even then.** A worker running this by hand already has
 * unrestricted Bash; the one caller `DEFAULT_TOOL_LIST` actually widens is `dispatch`,
 * the single-turn comment-answerer, which files nothing and has no batch to confirm —
 * same reasoning as `b7e-apply`, `b7e-take`, `b7e-swbump`.
 *
 * @grant excluded
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { parseProposal } from '../lib/proposal.js';
import { filedWhileLabel, bdReason } from '../lib/filing.js';
import { homeIn } from '../lib/homing.js';
import { isRoot } from '../lib/ownership.js';
import { withSurface } from '../lib/beadfiles.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (...names) => {
  for (const f of names) {
    const inline = argv.find((a) => a.startsWith(`${f}=`));
    if (inline) return inline.slice(f.length + 1);
    const at = argv.indexOf(f);
    if (at > -1) return argv[at + 1];
  }
  return undefined;
};

const USAGE = `usage: b7e-filed -w <workspace> --from <bead> [-f beads.yaml] [--repair] [--json]

Confirm a filing batch actually landed. Reads the same YAML spec that was piped to
bin/file.js (stdin, or -f) and reports, per intended title: filed exactly once /
unfiled / duplicate, the real bead id, its parent, labels, assignee, and whether the
description arrived whole.

  -w, --workspace <name>   which tracker (required)
  --from, -b <bead>        the bead that was being worked when the batch was filed
                           (required — this is the key filed-while:<from> is read by)
  -f, --file <path>        read the spec from a file instead of stdin
  --repair                 attach a missing parent to any singly-filed, non-root bead
  --json                   the machine-readable form instead of the printed report`;

if (has('--help') || has('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const wsName = value('-w', '--workspace');
const from = value('--from', '-b');
const file = value('-f', '--file');
const REPAIR = has('--repair');
const JSON_MODE = has('--json');

function fail(msg, code = 2) {
  console.error(`b7e-filed: ${msg}`);
  process.exit(code);
}

if (!wsName) fail(`-w/--workspace is required\n${USAGE}`);
if (!from) fail(`--from is required\n${USAGE}`);

const cfg = loadConfig();
const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws) {
  fail(`no workspace named "${wsName}"\nconfigured workspaces: ${cfg.workspaces.map((w) => w.name).join(', ') || 'none'}`, 4);
}

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

let fromKnown = false;
try {
  fromKnown = await bd.exists(ws, from);
} catch {
  fromKnown = false;
}
if (!fromKnown) fail(`${ws.name} has no bead ${from}`, 4);

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
let spec;
try {
  spec = YAML.parse(raw);
} catch (err) {
  fail(`that is not valid YAML — ${err.message.split('\n')[0]}`, 3);
}
const list = Array.isArray(spec) ? spec : spec?.beads;
// Round-tripped through the same parser bin/file.js uses, so a title here is truncated
// and normalised exactly as it would have been at filing time — the thing actually
// compared against what landed, not what the spec happened to type.
const parsed = parseProposal(['```beadproposal', YAML.stringify({ workspace: ws.name, beads: list }), '```'].join('\n'));
if (!parsed || parsed.error || !parsed.beads.length) fail(parsed?.error || 'no beads in that input', 3);

const label = filedWhileLabel(from);
const filedRows = await bd.listLabelAny(ws, label);
const byTitle = new Map();
for (const row of filedRows) {
  if (!byTitle.has(row.title)) byTitle.set(row.title, []);
  byTitle.get(row.title).push(row);
}

const home = await homeIn(bd, ws, { from });

const results = [];
for (const bead of parsed.beads) {
  const matches = byTitle.get(bead.title) || [];
  if (matches.length === 0) {
    results.push({ title: bead.title, status: 'unfiled' });
    continue;
  }
  if (matches.length > 1) {
    results.push({ title: bead.title, status: 'duplicate', ids: matches.map((m) => m.id) });
    continue;
  }

  const row = matches[0];
  const expectedBody = bead.files?.length ? withSurface(bead.description || '', bead.files) : bead.description || '';
  const expectedBytes = Buffer.byteLength(expectedBody, 'utf8');
  const actualBytes = Buffer.byteLength(row.description || '', 'utf8');
  const whole = expectedBytes === actualBytes;

  const priority = Number.isInteger(row.priority) ? row.priority : bead.priority;
  const rowIsRoot = isRoot({ type: row.issue_type || bead.type || 'task', priority });
  const stranded = !row.parent && home.gated && !rowIsRoot;

  let repaired = false;
  let repairError = null;
  if (REPAIR && stranded && home.parent) {
    try {
      await bd.adopt(ws, row.id, home.parent);
      repaired = true;
    } catch (err) {
      repairError = bdReason(err);
    }
  }

  results.push({
    title: bead.title,
    status: 'filed',
    id: row.id,
    parent: repaired ? home.parent : row.parent || null,
    labels: row.labels || [],
    assignee: row.assignee || null,
    description: { expectedBytes, actualBytes, whole },
    stranded: stranded && !repaired,
    repaired,
    repairError,
  });
}

const problem = (r) =>
  r.status === 'unfiled' || r.status === 'duplicate' || (r.status === 'filed' && (!r.description.whole || r.stranded));

if (JSON_MODE) {
  console.log(JSON.stringify({ workspace: wsName, from, home, repair: REPAIR, results }, null, 2));
} else {
  console.log(`b7e-filed ${from} · ${wsName} (${results.length} title${results.length === 1 ? '' : 's'})\n`);
  for (const r of results) {
    if (r.status === 'unfiled') {
      console.log(`  ✗ UNFILED    "${r.title}"`);
    } else if (r.status === 'duplicate') {
      console.log(`  ⚠ DUPLICATE  "${r.title}" — ${r.ids.join(', ')}`);
    } else {
      const bits = [];
      bits.push(r.parent ? `parent ${r.parent}${r.repaired ? ' (repaired)' : ''}` : 'NO PARENT');
      if (r.stranded) bits.push('stranded — nothing to hang it under, or --repair not passed');
      if (r.repairError) bits.push(`repair failed: ${r.repairError}`);
      bits.push(r.description.whole ? 'description whole' : `description TRUNCATED (${r.description.actualBytes}/${r.description.expectedBytes} bytes)`);
      if (r.assignee) bits.push(`assignee ${r.assignee}`);
      if (r.labels.length) bits.push(`labels ${r.labels.join(',')}`);
      console.log(`  ✓ ${r.id}  "${r.title}"\n      ${bits.join(' · ')}`);
    }
  }
  const bad = results.filter(problem);
  console.log(
    bad.length
      ? `\n${bad.length} of ${results.length} title(s) need attention.`
      : `\nAll ${results.length} title(s) filed exactly once, with a home, whole.`
  );
}

process.exitCode = results.some(problem) ? 1 : 0;
