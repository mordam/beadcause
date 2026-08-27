#!/usr/bin/env node
/**
 * File beads from a session, the moment it finds the work — for real, and held.
 *
 *   beadcause-file -w beadcause --from bc-7qo < beads.yaml
 *   beadcause-file -w beadcause --from bc-7qo -f beads.yaml
 *
 * A worker that trips over work mid-task **creates the bead itself**. It arrives
 * carrying `unendorsed`, and an unendorsed bead is not workable by anything — no
 * advocate queues it, no launcher will open a session on it (lib/endorse.js). So
 * nothing runs on what an agent decided was work until Adam endorses it from his
 * phone, where he can also adjust or revoke it; and the session that found it does not
 * wait for that. It files and carries on. See lib/filing.js for what goes on the bead
 * and why.
 *
 * **Unless the space says otherwise.** `autoEndorse` on the workspace's space
 * (lib/spaces.js) files without the hold, for the case where the tap was never a review:
 * a personal repo whose only reader is the person who would have pressed Endorse. Then
 * these beads are ready work the moment they exist. It is off unless asked for, it is not
 * something a session can ask for, and everything else on the bead is unchanged — the P2
 * ceiling, the `agent-filed` label and the `discovered-from` edge all still go on.
 *
 * This is the sibling of `beadcause-propose`, and the two are different acts now:
 *
 *   - **file** — "there is more work here". The bead exists; the review is after it.
 *   - **propose** — "should there be work here?". A question, nothing created until a
 *     button is pressed. Still what `--kind conflict` is, and still what an advocate
 *     does when it invents work from a survey rather than finding it in front of it.
 *
 * Input is YAML on stdin or `--file`: a list of beads, or `{ beads: [...] }`, in
 * exactly the shape `beadcause-propose` takes — the same shape `bd create` needs, so a
 * session that already knows one knows the other.
 *
 *   - title: Cache-bust site.js
 *     type: task
 *     priority: 2
 *     complexity: low          # low | medium | high, or leave it off
 *     description: |
 *       No ?v= on the script tag, so a shipped header change looks absent.
 *     acceptance: A deploy changes the URL.
 *     rationale: Found while reading webapp/templates/base.html for bc-7qo.
 *     files: [webapp/templates/base.html]   # optional: what it expects to touch
 *
 * `files` is written into the bead's description as the block lib/beadfiles.js reads, and
 * it is a forecast rather than a promise: nothing refuses a filing over it and a bead that
 * names none is filed exactly as every bead filed before bc-42ow was.
 *
 * Prints one id per line on stdout, so `$(beadcause-file …)` is a list of new beads.
 * Everything else — warnings, the duplicate flags, what was clamped — is stderr, since
 * the session that ran this is the one that can still say "yes, that is the same
 * thing" while it has the context to know.
 *
 * **A bead already on the graph is refused rather than filed.** Not on a title match — that
 * is a flag and stays one — but on lib/samejob.js's reading of whether this is the same
 * *job* as something already open, which is the only thing that catches the duplicates this
 * path actually produces. What the session wrote goes onto the bead that covers it, so the
 * observation survives the refusal, and `--force` files anyway for the session that
 * disagrees.
 *
 * Exit codes: 3 when the YAML names no beads (a session that piped the wrong thing
 * finds out rather than reporting success), 4 when at least one bead could not be
 * filed, 5 when at least one was refused as already filed. A partial failure still prints
 * the ids that did land.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { parseProposal, dupeNote } from '../lib/proposal.js';
import { annotateDuplicates, liveCandidates } from '../lib/dupe.js';
import { sameJob, refusalComment } from '../lib/samejob.js';
import { fileBeads, PRIORITY_FLOOR } from '../lib/filing.js';
import { autoEndorseAllowed } from '../lib/spaces.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);
const warn = (msg) => console.error(`beadcause-file: ${msg}`);

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const from = arg('--from', '-b');
const file = arg('--file', '-f');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || has('--help') || has('-h')) {
  console.error('usage: beadcause-file -w <workspace> [--from <bead>] [-f beads.yaml] [--force]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');

/**
 * Round-trip through the same parser the console and the proposal card use.
 *
 * The YAML is re-emitted from the parsed object rather than read field by field, so
 * every route into `bd create` normalises a bead the same way: one list of types, one
 * priority reading, one 200-character title. A session inventing `issue_type:` gets
 * the same answer here as it would on a proposal card.
 */
let spec;
try {
  spec = YAML.parse(raw);
} catch (err) {
  warn(`that is not valid YAML — ${err.message.split('\n')[0]}`);
  process.exit(3);
}
const list = Array.isArray(spec) ? spec : spec?.beads;
const parsed = parseProposal(['```beadproposal', YAML.stringify({ workspace: ws.name, beads: list }), '```'].join('\n'));
if (!parsed || parsed.error || !parsed.beads.length) {
  warn(parsed?.error || 'no beads in that input');
  process.exit(3);
}

// The same three the daemon builds it with (lib/server.js), so a workspace running a
// Dolt server rather than embedded Dolt is reached the same way from a pipe as from a
// phone — `bd` fails against a server that isn't there, and vice versa.
const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

/**
 * Is any of this already filed?
 *
 * A session filing mid-flight is the most likely thing in beadcause to file a
 * duplicate: it is deep in one bead, it has not read the tracker, and what it just
 * tripped over may well be what somebody else tripped over this morning — bc-9frx cost
 * a whole worker window to exactly that.
 *
 * It is a flag, not a veto, and that is a deliberate difference from the approval path
 * in lib/server.js, which refuses to create over a duplicate the card did not mention.
 * There, refusing sends the question back to a human who is already looking at it.
 * Here there is nobody to send it back to, the bead cannot be worked either way, and a
 * 0.9 title similarity is not proof of the same bug. So it is filed with the
 * resemblance written into its notes, where the endorsement queue shows it and
 * revoking is one tap.
 */
let beads = parsed.beads;
let live = [];
try {
  live = (await bd.json(ws, ['list', '--status=open,in_progress,blocked', '--limit', '0'])) || [];
  beads = annotateDuplicates(parsed.beads, liveCandidates(live, { ignore: [from] }));
  for (const b of beads) {
    if (b.duplicate) warn(`⚠︎ "${b.title}" is ${dupeNote(b.duplicate)} — flagged on the bead`);
  }
} catch (err) {
  // A lookup that fails must not lose the discovery: an unflagged bead is what every
  // bead was until bc-9frx, and it is still held, still read before anything runs.
  warn(`filing without a duplicate check — ${String(err.message).split('\n')[0]}`);
}

/**
 * And is any of it the same *job* as something already open, in words that do not match?
 *
 * The flag above is a 0.9 word-set match, which is near-verbatim and catches only a bead
 * typed twice. It caught none of the twelve duplicates beadcause has had to mark
 * `superseded-by:` by hand — they score 0.07 to 0.64 against the beads they duplicate, and
 * eleven of the twelve came through this very path. lib/samejob.js is the measurement and
 * the net: a shortlist of what this could already be, then one read-only judge over it.
 *
 * **This one refuses, where the flag does not, and the difference is what a refusal costs
 * here.** lib/dupe.js's rule is that refusing loses work nobody can send back — true of a
 * crash the daemon files on itself at 04:00, and not true of this caller. A session ran
 * this command and is still holding the context that produced it; it is told exactly which
 * bead covers the work, its observation is written onto that bead rather than dropped, and
 * `--force` files anyway in the same breath. That is a conversation, not a loss.
 *
 * Sequential on purpose. A batch is two or three beads and each judge is a `claude -p`;
 * running them at once would put three models on one worker's critical path to save
 * seconds nobody is waiting on.
 */
const refused = [];
if (!has('--force') && beads.length) {
  const keep = [];
  for (const b of beads) {
    let verdict = { duplicate: null };
    try {
      // `dirs` is the checkout, and it is not optional: `guessedFiles` returns nothing at
      // all when it has no directory to test a path against, which would quietly reduce the
      // surface signal to declared `files:` alone — the half most beads do not carry. The
      // cwd is the right answer and needs no config: a worker runs this from inside the
      // worktree it is working, which is the checkout every path in its discovery is about.
      verdict = await sameJob(b, live, { dirs: [process.cwd()], ignore: [from], cfg, dir: process.cwd(), onWarn: warn });
    } catch (err) {
      // Belt and braces: `sameJob` already turns every failure into a pass, and a throw
      // getting past it must still not be the thing that loses a discovery.
      warn(`filing without the duplicate judge — ${String(err.message).split('\n')[0]}`);
    }
    if (!verdict.duplicate) {
      keep.push(b);
      continue;
    }
    refused.push({ ...b, covered: verdict.duplicate, why: verdict.why });
  }
  beads = keep;
}

/**
 * What the covering bead is told, and what the session is told.
 *
 * The comment goes on first and a failure to write it does not un-refuse the filing: the
 * refusal has already been decided and reported, and a bead that could not take a comment
 * is a tracker problem rather than a reason to open a second bead on one job.
 */
for (const r of refused) {
  try {
    await bd.comment(ws, r.covered, refusalComment(r, { why: r.why, from }));
  } catch (err) {
    warn(`could not comment on ${r.covered} — ${String(err.message).split('\n')[0]}`);
  }
  warn(
    `✗ NOT FILED: "${r.title}" — ${r.covered} already covers this${r.why ? `: ${r.why}` : ''}. ` +
      `What you wrote is now a comment on ${r.covered}. If it is really different work, run this again ` +
      'with --force and say on both what the difference is.'
  );
}

/**
 * Does this workspace's space file without the hold?
 *
 * Read here, once, from the config this process already loaded — the same
 * `autoEndorseAllowed` the space details screen draws and the session brief is written
 * from (lib/spaces.js). Nothing on the command line can ask for it: a session cannot
 * endorse its own discoveries, whatever it thinks of them, and a `--endorse` flag would
 * be exactly that. The answer belongs to the space.
 */
const endorsed = autoEndorseAllowed(cfg, ws.name);

const { filed, failed, home } = await fileBeads(bd, ws, beads, { from, onWarn: warn, endorsed });

/**
 * Where they landed, once for the batch — they all share one home (lib/homing.js). Said
 * out loud rather than left to `bd show`, because a bead quietly adopted into an epic the
 * session never named is the kind of surprise a worker should be able to correct in the
 * same breath it filed in.
 *
 * **Over what actually landed, not over what was decided, and bc-xl7n.65 is the whole
 * reason.** `home` is the answer `lib/homing.js` gave; a bead whose `--parent` bd then
 * refused is re-filed without one, and this line used to print the answer regardless. So
 * a session was told *filed under bc-eqn1.1* about a bead sitting under nothing — the
 * refusal was two lines above, truncated to the session's own title, and the reassuring
 * sentence was the last word. Every one of those beads was invisible to its own filer.
 */
const homed = filed.filter((b) => b.parent);
const stranded = filed.filter((b) => !b.parent);
if (home?.why && homed.length) {
  warn(`filed under ${home.why} — nothing named a home, and a bead with nothing decided above it is not workable`);
}
if (home?.parent && stranded.length) {
  warn(
    `${stranded.length === 1 ? '1 of them is' : `${stranded.length} of them are`} filed with NO PARENT — ` +
      `${home.parent} would not take ${stranded.length === 1 ? 'it' : 'them'} (the refusal is above). ` +
      `Nothing will work ${stranded.length === 1 ? 'it' : 'them'} until you adopt ${stranded.length === 1 ? 'it' : 'them'} ` +
      `under an epic: ${stranded.map((b) => b.id).join(', ')}`
  );
}

for (const b of filed) {
  if (b.clamped) warn(`"${b.title}" filed at P${b.priority} — an agent-filed bead may not outrank P${PRIORITY_FLOOR}`);
}
for (const b of failed) warn(`could not file "${b.title}" — ${b.error}`);

if (filed.length) {
  const count = filed.length === 1 ? '1 bead' : `${filed.length} beads`;
  // Two different facts, and the session is told which one is true rather than the
  // reassuring one. "Held for endorsement" over an auto-endorsing space would have a
  // worker report that nothing runs until Adam looks, minutes before an advocate opens
  // a window on it.
  warn(
    endorsed
      ? `filed ${count}, endorsed — auto-endorsement is on for this repo, so they are ready work ` +
          'and an advocate may pick them up. Carry on with what you were doing; they are not yours.'
      : `filed ${count}, held for endorsement — ` +
          'nothing will be worked on them until they are endorsed. Carry on with what you were doing.'
  );
}

for (const b of filed) console.log(b.id);

// Nothing filed at all is a failure whatever the reason; some of it filed is still a
// failure, because the caller asked for beads it has not got and only it knows whether
// to say so on the bead it is working.
//
// A refusal is its own code and it is not 4. Both mean "you did not get every bead you
// asked for", and a session that cannot tell them apart cannot do the one thing that
// differs: a bead that FAILED is worth filing again, and a bead that was REFUSED is
// already on the graph and filing it again is the mistake. 4 wins a tie, because a
// tracker that would not take a bead is the worse of the two problems.
process.exit(failed.length ? 4 : refused.length ? 5 : 0);
