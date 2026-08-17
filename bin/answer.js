#!/usr/bin/env node
/**
 * `beadcause-answer` — the worker's reply to a review, written where the next round reads it.
 *
 *     beadcause-answer -w beadcause -b bc-dxrt <<'EOF'
 *     - id: c1
 *       answer: changed
 *       note: split the parse out so the empty case is one branch
 *     - id: c2
 *       answer: declined
 *       note: the caller already holds the lock, so a second one would deadlock
 *     EOF
 *
 * bc-36xx.6. A ReviewAdvocate reads a delivered pull request and leaves comments on the
 * merge-bead; a sweep opens a worker window on the branch with those comments in its brief
 * (`reviewAnswerPrompt`, lib/reviewanswer.js); that window changes what it agrees with and runs
 * this. The answers go into the review block on the merge-bead's `notes`, which is what the
 * reviewer reads on its next pass — the window itself does not survive the round.
 *
 * ## Why the worker does not write the block itself
 *
 * `notes` is one field with two state blocks in it, and the merge queue rewrites its own
 * every tick. A session composing YAML into that field by hand has to find the right
 * markers, keep the other block intact, keep the reviewer's `resolved` flags, and not drop
 * a comment it was not answering — four things to get right, in an unattended window, on a
 * field whose loss is somebody's review. This does all four through the same cutter every
 * other writer uses (`withReviewBlock`), and refuses rather than guesses on anything it
 * cannot match.
 *
 * ## What it will not let you say
 *
 * `resolved`. That is the reviewer's field and the refusal is deliberate rather than a
 * silent drop — see lib/reviewanswer.js. Everything else it refuses (an id that is not on the
 * review, an answer outside `changed`/`clarify`/`declined`, a decline with no reason) is
 * one sentence back to the session, because the caller is an agent that can fix it and run
 * the command again.
 *
 * ## The push check
 *
 * A `changed` whose commits are still sitting in the worktree is the worst outcome this
 * command has: the reviewer reads the branch as it was, disagrees with the answer for
 * reasons the worker has already fixed, and the round is spent. So when git can answer, an
 * unpushed commit stops a `changed` — with `--anyway` for the case where the session knows
 * better. When git cannot answer (no upstream, not a checkout, a repo it cannot read) the
 * check is skipped rather than failed: not knowing is not evidence.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Bd } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { answerComment, checkAnswers, parseAnswers, withAnswers } from '../lib/reviewanswer.js';
import { isMergeBead, mergeSpec, openMergeBeadFor, reviewState, withReviewBlock } from '../lib/mergebead.js';

const argv = process.argv.slice(2);
function arg(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i > -1) return argv[i + 1];
  }
  return undefined;
}
const has = (...names) => names.some((n) => argv.includes(n));

const die = (msg, code = 1) => {
  console.error(`beadcause-answer: ${msg}`);
  process.exit(code);
};

const cfg = loadConfig();
const wsName = arg('-w', '--workspace') || cfg.workspaces[0]?.name;
const beadArg = arg('-b', '--bead', '--id');
const file = arg('-f', '--file');
const dryRun = has('-n', '--dry-run');
const anyway = has('--anyway');

const ws = (cfg.workspaces || []).find((w) => w.name === wsName);
if (!ws || !beadArg) {
  console.error("usage: beadcause-answer -w <workspace> -b <merge-bead or work bead> [-f answers.yaml] [-n] [--anyway]");
  console.error(`workspaces: ${(cfg.workspaces || []).map((w) => w.name).join(', ') || '(none)'}`);
  process.exit(1);
}

const text = (file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')).trim();
if (!text) {
  die(
    'nothing was piped in, so nothing was written. One entry per comment you are answering:\n' +
      '  - id: c1\n    answer: changed|clarify|declined\n    note: <one line>'
  );
}
const raw = parseAnswers(text);
if (!raw) die('what was piped in is not YAML this can read — one list entry per comment, with `id`, `answer` and `note`');

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

/**
 * Which bead the review is on — and the worker is allowed to name either.
 *
 * The block lives on the **merge-bead**, and that is the id the brief prints. But a
 * reopened worker is a worker: the id in its head, in its window title and on every other
 * command it runs is its **work bead**, and a command that refused that one would be
 * refusing the obvious mistake rather than absorbing it. `openMergeBeadFor` is the same
 * finder `bin/deliver.js` uses to avoid filing a second queue entry, so "the open
 * merge-bead for this work" means one thing across the tree.
 */
let row;
try {
  row = await bd.show(ws, beadArg);
} catch (err) {
  die(`could not read ${beadArg} — ${String(err?.message || err).split('\n')[0]}`, 5);
}
if (!row) die(`there is no bead ${beadArg} in ${ws.name}`, 4);

if (!isMergeBead(row)) {
  let rows;
  try {
    rows = await bd.listLive(ws);
  } catch (err) {
    die(`could not read the ${ws.name} tracker — ${String(err?.message || err).split('\n')[0]}`, 5);
  }
  const found = openMergeBeadFor(rows, { bead: row.id });
  if (!found.length) {
    die(
      `${row.id} is not a merge-bead and nothing open carries its pull request — a review is answered on the ` +
        'bead the queue holds, and there is none for this work'
    );
  }
  if (found.length > 1) {
    die(`${found.map((f) => f.id).join(', ')} are all open about ${row.id}, so which review this answers is not something this can pick`);
  }
  row = await bd.show(ws, found[0].id);
  if (!row) die(`the merge-bead ${found[0].id} vanished between reading the queue and reading it`, 4);
}

const spec = mergeSpec(row);
if (!spec || spec.error) die(`${row.id} carries no readable pull request block${spec?.error ? ` — ${spec.error}` : ''}`, 4);

const state = reviewState(row);
if (!state.comments.length) {
  die(`nothing has reviewed #${spec.number} yet — there are no comments on ${row.id} to answer`);
}

const { answers, error } = checkAnswers(raw, state);
if (error) die(error);

/* --------------------------------------------------------------- what the branch is at */

/**
 * The head, and whether it has left this Mac — best effort, and silent when git will not say.
 *
 * Run in the working directory rather than in a checkout this resolves, because the caller
 * is a session standing in the worktree that holds the branch. Anything unreadable means
 * the sha is left out of the comment and the push check does not fire, which is the
 * direction that costs a sentence rather than a refusal.
 */
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let sha = '';
let unpushed = null;
try {
  sha = git(['rev-parse', 'HEAD']);
  unpushed = Number(git(['rev-list', '--count', '@{u}..HEAD']));
  if (!Number.isInteger(unpushed)) unpushed = null;
} catch {
  unpushed = null;
}

const changed = answers.filter((a) => a.answer === 'changed');
if (changed.length && unpushed && !anyway) {
  die(
    `${changed.map((a) => `\`${a.id}\``).join(', ')} ${changed.length === 1 ? 'says' : 'say'} \`changed\`, and this ` +
      `branch has ${unpushed} commit${unpushed === 1 ? '' : 's'} that ${unpushed === 1 ? 'is' : 'are'} not pushed. ` +
      'The reviewer reads the branch on GitHub, so push first and run this again — or `--anyway` if the change ' +
      'genuinely is not in a commit here.',
    3
  );
}

/* ---------------------------------------------------------------------------- the writes */

const next = withAnswers(state, answers);
const notes = withReviewBlock(row.notes, next);
const comment = answerComment(answers, { round: state.round, sha, pushed: changed.length ? unpushed === 0 : null });

if (dryRun) {
  console.log(`would answer ${answers.length} comment${answers.length === 1 ? '' : 's'} on ${row.id} (#${spec.number})`);
  console.log(comment);
  process.exit(0);
}

// The block first and the comment second: the block is what the next round parses and the
// comment is what a person reads, so a failure between them leaves the review correct and
// the prose missing rather than the other way round.
try {
  await bd.update(ws, row.id, { notes });
} catch (err) {
  die(`the answers did not land on ${row.id} — ${String(err?.message || err).split('\n')[0]}`, 5);
}
try {
  await bd.comment(ws, row.id, comment);
} catch (err) {
  console.error(
    `beadcause-answer: the answers are on ${row.id}, but the comment did not land ` +
      `(${String(err?.message || err).split('\n')[0]}). The review block is the record; nothing is lost.`
  );
}

console.log(`answered ${answers.length} comment${answers.length === 1 ? '' : 's'} on ${row.id} — #${spec.number}`);
for (const a of answers) console.log(`  ${a.id}: ${a.answer}${a.note ? ` — ${a.note}` : ''}`);
const left = next.comments.filter((c) => !c.resolved && !c.answer).length;
console.log(
  left
    ? `  ${left} comment${left === 1 ? '' : 's'} still unanswered — the reviewer sees them as open next round`
    : '  every open comment now has an answer; the ReviewAdvocate decides next round which of them that settles'
);
