#!/usr/bin/env node
/**
 * Propose beads from a session, the moment it finds the work.
 *
 *   beadcause-propose -w beadcause --from bc-7qo --kind discovery < beads.yaml
 *   beadcause-propose -w beadcause --from bc-7qo --kind conflict -f conflict.yaml
 *
 * The rule this exists to serve is unchanged and absolute: **an agent may not create
 * a bead.** Adam approves every bead before it exists. What changed is *when* he gets
 * to approve one. A session used to write its discoveries into a `## Discovered`
 * comment and carry on, and those sat there — invisible, unanswerable — until the
 * repo's advocate ran out of ready work and surveyed the comments, which on a busy
 * repo is never. So the discovery arrived a fortnight after the context that made it
 * obvious had gone.
 *
 * Now the session proposes at the moment of discovery: one ordinary `human` question
 * carrying the full text of every bead it wants, which reaches the phone through the
 * same channel and the same card as an advocate's proposal, with the same ✓ / ✎ / ✕
 * per row. Nothing is created until a button is pressed. See lib/proposal.js.
 *
 * Input is YAML on stdin or `--file`: a list of beads, or `{ beads: [...] }`, in
 * exactly the shape the `beadproposal` block takes.
 *
 *   - title: Cache-bust site.js
 *     type: task
 *     priority: 2
 *     description: |
 *       No ?v= on the script tag, so a shipped header change looks absent.
 *     acceptance: A deploy changes the URL.
 *     rationale: Found while reading webapp/templates/base.html for bc-7qo.
 *
 * Prints the new question's id. Exits 3 when the YAML names no beads, so a session
 * that piped it the wrong thing finds out rather than reporting success.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { loadConfig } from '../lib/config.js';
import { parseProposal, proposalBody, proposalTitle, dupeNote } from '../lib/proposal.js';
import { annotateDuplicates, liveCandidates } from '../lib/dupe.js';
import { parseJson } from '../lib/bd.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const from = arg('--from', '-b');
const file = arg('--file', '-f');
const kind = (arg('--kind', '-k') || 'discovery').toLowerCase();
const priority = arg('--priority', '-p') ?? '2';

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || has('--help') || has('-h')) {
  console.error('usage: beadcause-propose -w <workspace> [--from <bead>] [--kind discovery|conflict] [-f beads.yaml]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');

/**
 * Round-trip through the same parser the server will use.
 *
 * The YAML is re-emitted from the parsed object rather than passed through, so a
 * proposal that survives this command is one the server can definitely read back —
 * the alternative is a card that renders and an approval that then creates nothing.
 */
let spec;
try {
  spec = YAML.parse(raw);
} catch (err) {
  console.error(`beadcause-propose: that is not valid YAML — ${err.message.split('\n')[0]}`);
  process.exit(3);
}
const list = Array.isArray(spec) ? spec : spec?.beads;
const parsed = parseProposal(['```beadproposal', YAML.stringify({ workspace: ws.name, beads: list }), '```'].join('\n'));
if (!parsed || parsed.error || !parsed.beads.length) {
  console.error(`beadcause-propose: ${parsed?.error || 'no beads in that input'}`);
  process.exit(3);
}

/**
 * The lead sentence, which is the whole difference between the two kinds.
 *
 * A discovery is "I found something while doing other work". A conflict is "I stopped
 * because two things disagree and resolving it is not mine to do" — and the second is
 * urgent in a way the first is not, because a session is very likely parked on it.
 */
const INTRO = {
  discovery: `A **${ws.name}** session${from ? ` working **${from}**` : ''} found work worth tracking and wants to file ${
    parsed.beads.length === 1 ? 'a bead' : `${parsed.beads.length} beads`
  }.`,
  conflict: `A **${ws.name}** session${from ? ` working **${from}**` : ''} hit something it must not decide on its own${
    from ? ` and has stopped on ${from}` : ''
  }.`,
};

const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: cfg.actor };
const bd = (args) => execFileSync(cfg.bdBin, args, { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * Is any of this already filed?
 *
 * A session proposing mid-flight is the most likely thing in beadcause to propose a
 * duplicate: it is deep in one bead, it has not read the tracker, and what it just
 * tripped over may well be the thing somebody else tripped over this morning. bc-9frx
 * cost a whole worker window to exactly that. So the titles are checked against the
 * live set — beads *and* the proposals still waiting for an answer, since for most of
 * the day bc-j6x and bc-ec6 were the second kind.
 *
 * The proposal is filed either way: a flag is a warning to Adam, not a veto on a
 * session that may well have found a genuinely different bug with a similar name. The
 * warning goes to stderr as well, because the session that ran this is the one that can
 * say "yes, that is the same thing" while it still has the context to know.
 */
let flagged = parsed.beads;
try {
  const live = parseJson(bd(['list', '--status=open,in_progress,blocked', '--limit', '0', '--json'])) || [];
  flagged = annotateDuplicates(parsed.beads, liveCandidates(live, { ignore: [from] }));
  for (const b of flagged) {
    if (b.duplicate) console.error(`beadcause-propose: ⚠︎ "${b.title}" is ${dupeNote(b.duplicate)} — flagged on the card`);
  }
} catch (err) {
  // A lookup that fails must not lose the proposal — an unflagged card is what every
  // card was until now, and the server checks again at the moment of approval.
  console.error(`beadcause-propose: proposing without a duplicate check — ${String(err.message).split('\n')[0]}`);
}

const body = proposalBody(ws.name, flagged, {
  intro: INTRO[kind] || INTRO.discovery,
  context: from ? `_Filed from a session working ${from}, while the reason for it was still on screen._` : '',
});

const out = bd([
  'create',
  '--title',
  proposalTitle(ws.name, parsed.beads),
  '--type',
  'task',
  '--priority',
  String(kind === 'conflict' ? 1 : priority),
  '--label',
  'human',
  '--label',
  // The same label an advocate's proposal carries, so one search finds every bead
  // that was proposed rather than filed, whoever proposed it. The kind is a second
  // label rather than a different first one, for the same reason.
  'advocate-proposal',
  '--label',
  `proposed-${kind === 'conflict' ? 'conflict' : 'discovery'}`,
  '--description',
  body,
  '--json',
]);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const id = created.id || created.issue?.id;

// A conflict blocks the bead that hit it: the session is stopped, and a bead that is
// merely "open" would be handed straight back to the next advocate tick, which would
// open a second session onto the same wall. A discovery blocks nothing — the work
// that found it carries on.
if (kind === 'conflict' && from) {
  try {
    bd(['dep', 'add', from, id]);
  } catch (err) {
    console.error(`beadcause-propose: filed ${id}, but could not park ${from} behind it — ${String(err.message).split('\n')[0]}`);
  }
}

console.log(id);
