#!/usr/bin/env node
/**
 * Ask Adam a question from an agent session.
 *
 *   beadcause-ask --workspace acme --title "Gross or net platform fee?" --file brief.md
 *   cat brief.md | beadcause-ask -w acme -t "Which auth flow?"
 *
 * Creates a bead labelled `human` whose body is the markdown you piped in —
 * decision block and all. Piping the body avoids the shell-quoting misery of
 * putting a fenced block inside --description on the command line.
 *
 * Prints the new issue id. Add `--blocks <id>` to park the work that depends on
 * the answer: it goes blocked until you answer on the phone, then shows up in
 * `bd ready` on its own.
 *
 * **The body has to end with a `decision` block, and this refuses it if it does not.**
 * That is the rule in lib/decision.js — `decisionTail` is the check and it is the same
 * one the briefs teach — and the refusal is here rather than only in the wording because
 * a rule stated in a prompt is a rule some fraction of sessions read past. It costs an
 * obedient caller nothing and a forgetful one one retry, and the message it prints is the
 * template with the failure named above it, so the retry is a paste rather than a hunt.
 *
 * Refusing *before* the create is not incidental: it is the only place a refusal is free.
 * Past the create the bead is on somebody's phone, which is why everything below that
 * line reports rather than exits (see the note on `park`).
 *
 * `--no-options` is the exception, and it is narrow on purpose: a question that is a
 * *fact* rather than a choice — a password, a number nobody wrote down, "which file did
 * you mean" — has nothing to offer, and a block invented to satisfy a check would put two
 * made-up answers in front of a reader whose real answer is neither. The flag says the
 * question has no options; it does not say the check is inconvenient. `--free-text` is
 * accepted as the same flag, because that is the other word a session reaches for and a
 * refusal over the spelling of the escape hatch teaches nothing.
 *
 * `--for <who>` says whose decision this is on a tracker more than one person reads —
 * `--for everyone` puts it on every phone. Left off it is this Mac's person, and on a
 * single-person install (`me` unset) there is no addressee at all and nothing changes.
 *
 * The parking is the fiddly half and lib/park.js holds the reason: bd will only let
 * an epic be blocked by another epic, so the bead being parked is looked up *before*
 * the question is created and the question is typed to match it. Everything about
 * that order matters — the question exists after this point, so from here on nothing
 * may exit non-zero and nothing may fail to print the id. See bc-p9vx.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { beadRow, park, questionType } from '../lib/park.js';
import { addresseeLabel, meHandles } from '../lib/addressee.js';
import { bylineFor } from '../lib/byline.js';
import { askTemplate, decisionTail } from '../lib/decision.js';

const flag = (...names) => names.some((n) => process.argv.includes(n));

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}

const cfg = loadConfig();
const wsName = arg('--workspace', '-w');
const title = arg('--title', '-t');
const file = arg('--file', '-f');
const priority = arg('--priority', '-p') ?? '1';
const blocks = arg('--blocks', '-b');

/**
 * Who this question is for — and why the default is *this machine's person*.
 *
 * On one Mac this changes nothing: `me` is unset, `addressee` is null, no label goes on
 * the bead, and every phone that can see the graph rings exactly as it always has.
 *
 * On a shared tracker it is the whole feature, and it is derived here rather than read
 * back later for a reason worth stating: the daemon reading the graph cannot route on
 * `created_by`. It is `cfg.actor`, a byline — bare `beadcause` until this machine sets
 * `me`, `beadcause (carol@example.com)` after (lib/byline.js), bare on every bead filed
 * before that, and a field an agent can write anything into. The machine doing the
 * *asking* knows perfectly well who the question belongs to, so the addressee is
 * stamped at the moment the question is written, by the only process that has the
 * answer — as a label, which every bd client can read.
 *
 * `--for` overrides it, in both directions: a name to put the question on somebody
 * else's phone, or `--for everyone` to put it on all of them, which is what a question
 * that genuinely is anybody's wants and is otherwise unreachable once `me` is set.
 * Every machine's `me` is one of these labels' handles, so an addressed question is
 * still visible to all six — see lib/addressee.js. It only ever decides who is *rung*.
 */
const addressee = arg('--for') ?? meHandles(cfg)[0] ?? '';
const forLabel = addresseeLabel(addressee);

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !title) {
  console.error(
    'usage: beadcause-ask -w <workspace> -t <title> [-f brief.md] [-p 1] [-b <blocked-issue-id>] [--for <who|everyone>] [--no-options]'
  );
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const body = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');

/**
 * The gate — see the header for why it is a refusal and why it is *here*, above the
 * create, rather than anywhere below it.
 *
 * The message is the whole point of the gate. A bare "rejected" teaches a session that
 * this command is unreliable and the next thing it does is drop the question, which is
 * the outcome the brief spends a paragraph arguing against — a question kept to yourself
 * is the same as no question at all. So it names the one thing that is wrong, prints the
 * block to paste, and names the one legitimate way past it in the same breath.
 */
if (!flag('--no-options', '--free-text')) {
  const tail = decisionTail(body);
  if (!tail.ok) {
    console.error(`beadcause-ask: nothing was asked — ${tail.reason}.`);
    console.error('');
    console.error('A question ends with its options, and one of them is recommended. Put this at the');
    console.error('bottom of the body, with nothing after it, and run it again:');
    console.error('');
    console.error(askTemplate('  '));
    console.error('');
    console.error('If this is a fact rather than a choice — a password, a number nobody wrote down —');
    console.error('there is nothing to offer and inventing options would be worse: pass --no-options.');
    process.exit(1);
  }
}

/**
 * The byline, and why it is on the argv as well as in the environment.
 *
 * `bylineFor` is the same string the daemon writes under — `beadcause`, or
 * `beadcause (carol@example.com)` on a machine that has said who it is — so a question
 * asked from a session on one engineer's Mac says whose Mac it was (lib/byline.js).
 *
 * `BEADS_ACTOR` alone is not enough to make it stick: a workspace `config.yaml` with an
 * `actor:` in it could take precedence over the environment variable, and the flag beats
 * both whichever way round that is — see the re-measurement in `Bd.run`. lib/bd.js has
 * carried the flag since that was measured; the three CLIs did not, so a workspace
 * pinning an actor silently overwrote the byline on everything they filed. Appended to
 * every call rather than to the writes, exactly as `Bd.run` does it, because the reads
 * take it harmlessly and a helper with two shapes is a helper somebody uses the wrong
 * one of.
 */
const byline = bylineFor(cfg);
const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: byline };
const bd = (args) =>
  execFileSync(cfg.bdBin, [...args, '--actor', byline], { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/**
 * Everything that can still refuse the whole command happens here, before the create.
 *
 * A bead id that is not in this workspace is a typo, and a typo caught now costs the
 * session one retry; caught after the create it costs Adam a question about a bead
 * that does not exist and the session an unparked bead it thinks is parked.
 */
const target = blocks ? beadRow(bd, blocks) : null;
if (blocks && !target) {
  console.error(`beadcause-ask: no bead ${blocks} in ${ws.name} — nothing was asked. Check the id and run it again.`);
  process.exit(1);
}
const type = questionType(target?.issue_type);

const out = bd([
  'create',
  '--title', title,
  '--type', type,
  '--priority', String(priority),
  '--label', 'human',
  ...(forLabel ? ['--label', forLabel] : []),
  '--description', body,
  '--json',
]);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const id = created.id || created.issue?.id;

// The question exists from here on, so this cannot throw and cannot exit non-zero: a
// caller told the command failed over a question that is already on the phone either
// asks nothing or asks twice. `park` reports instead, in one sentence.
if (blocks) {
  // `note` rather than `!parked`: a park that worked can still have had to take a prose
  // mention's see-also off the pair to do it (bc-arj0.23), and that is worth a line.
  const { note } = park(bd, blocks, id);
  if (note) console.error(`beadcause-ask: ${note}`);
}

console.log(id);
