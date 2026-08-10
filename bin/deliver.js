#!/usr/bin/env node
/**
 * Land finished work: push it, open the pull request, merge it.
 *
 *   beadcause-deliver -w beadcause -b bc-7qo --tests "npm test — 42 passing" < summary.md
 *
 * This is how a session ends. It once ended by merging into main on this laptop and
 * closing its bead, which only worked while Adam was the only one who ever merged —
 * with several sessions a day they raced each other into main, and every conflict
 * landed on him anyway, in the worst possible form. So it became a pull request and a
 * question on his phone, and nothing merged until he tapped.
 *
 * That fixed the race and introduced a queue. Every finished piece of work waited for
 * him: a bead finished at three in the morning sat unmerged until breakfast, and the
 * next bead to touch the same file started from a `main` that did not have it. The
 * gate was doing far less reviewing than waiting.
 *
 * So this now does five things, in this order, and the fifth is the whole change:
 *
 * 1. Pushes the branch. **Only ever a branch** — this refuses to run on main, and
 *    nothing in beadcause can push to main at all.
 * 2. Opens the pull request, or finds the one already open for the branch, which is
 *    the ordinary case on the second delivery after changes were requested.
 * 3. Waits for that pull request's checks to report — see `settle` in lib/pr.js.
 * 4. Merges it, through `gh`, the same call and the same preflight as the button on
 *    the phone. GitHub serialises the merges, which is what keeps step 5 of five
 *    concurrent workers from being the race this was invented to stop, and it is why
 *    the merge happens *there* rather than in a `git merge` on local main.
 * 5. Closes the work bead, because the merge is what made it true, and pushes a
 *    notification with nothing to answer.
 *
 * **The old ending is intact and it is the fallback.** Anything that stops the merge —
 * GitHub refusing it, a red check, checks that never reported, `pr.autoMerge` off, or
 * `--review` because the session wants a human on this one — files exactly the
 * question it always filed, with the reason on it, and parks the bead behind it. That
 * is not a failure path bolted on the side; it is the same forty lines it always was,
 * reached less often.
 *
 * What it never does is deploy. The merge is on `origin`; whether that is *running* is
 * a separate act with a separate button (the PR board's Ship), because what a deploy
 * even is lives in each repo's CLAUDE.md and a worker being right about the merge does
 * not make it right about that.
 *
 * Prints `landed #<n> <url> <sha>` when it merged, or `<question-id> <pr-url>` when it
 * handed it over. Exits non-zero, loudly, on every condition where carrying on would
 * produce a PR that misrepresents what is in the branch — a dirty tree, no commits, a
 * detached head. A merge that did not happen is **not** one of those: the work is
 * pushed, the PR is open, the question is filed, and that is a good ending.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { ownerName } from '../lib/owner.js';
import { deliveryBody, deliveryTitle, DELIVERY_LABEL } from '../lib/delivery.js';
import { deployFor, deployHint } from '../lib/deploy.js';
import { pushLanded } from '../lib/notify.js';
import * as pr from '../lib/pr.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);

const die = (msg, code = 1) => {
  console.error(`beadcause-deliver: ${msg}`);
  process.exit(code);
};

/** An error's first line. Everything reported *after* a merge has landed uses this. */
const first = (err) => String(err?.message || err || '').split('\n')[0];

/** squash | merge | rebase, normalised once. An unknown one is a typo, not a request. */
const mergeMethod = (m) => (['squash', 'merge', 'rebase'].includes(m) ? m : 'squash');

const cfg = loadConfig();
// What the pull request body and the argument errors call whoever is reviewing this.
const owner = ownerName(cfg);
const wsName = arg('--workspace', '-w');
const beadId = arg('--bead', '-b');
const base = arg('--base') || 'main';
const method = mergeMethod((arg('--method') || 'squash').toLowerCase());
const tests = arg('--tests') || '';
const risk = arg('--risk') || '';
const left = arg('--left') || '';
const titleArg = arg('--title', '-t');
const summaryFile = arg('--file', '-f');
const dir = path.resolve(arg('--dir') || process.cwd());
// What the session says is still outstanding *after* the merge — a deploy, a rebuild,
// both, or nothing. Passed through to the bead and the notification rather than worked
// out here: the daemon knows the repo, but only the session knows what it touched.
const owed = arg('--owed') || '';
/**
 * Ask rather than merge, on the session's own judgement.
 *
 * The one escalation a worker may make unilaterally, and it exists because the
 * alternative is worse than a slow queue. A session that has just done something it is
 * genuinely unsure about — a migration, a permissions change, a rewrite it thinks is
 * right but wide — should be able to say so, and the only thing it could otherwise do
 * with that feeling is merge anyway and mention it in a comment nobody reads until
 * later. The card it produces says outright that the worker chose this, so a green
 * pull request sitting in the inbox does not read as a bug.
 */
const review = has('--review') || has('--no-merge');

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !beadId || has('--help') || has('-h')) {
  console.error(
    'usage: beadcause-deliver -w <workspace> -b <bead> [--base main] [--method squash] [--tests "..."]\n' +
      '                        [--risk "..."] [--left "..."] [--owed "deploy, rebuild"] [--review] [-f summary.md]'
  );
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

/* ---------------------------------------------------------------- the branch */

let branch;
try {
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
} catch (err) {
  die(`${dir} is not a git checkout — ${String(err.message).split('\n')[0]}`);
}
if (branch === 'HEAD') die('this checkout is on a detached head; a PR needs a branch');
if (['main', 'master', base].includes(branch)) {
  die(`refusing to open a PR from ${branch} into ${base} — the work should be on its own branch`);
}

// A dirty tree is the one failure worth being rude about: the PR would describe work
// that is on this laptop and nowhere else, and it would look complete.
const dirty = git(['status', '--porcelain']);
if (dirty) {
  die(`the worktree has uncommitted changes — commit them first, they are not in the PR:\n${dirty}`, 2);
}

// Commits against the base as the remote has it, not as this laptop last saw it.
try {
  git(['fetch', 'origin', base, '--quiet']);
} catch {
  /* offline, or no such remote branch. The count below is then against the local ref. */
}
const upstream = git(['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : base;
const ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`]));
if (!ahead) die(`${branch} has no commits that ${upstream} does not — there is nothing to deliver`, 2);

/* ------------------------------------------------------------------- the bead */

const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: cfg.actor };
const bd = (args) => execFileSync(cfg.bdBin, args, { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

let bead = null;
try {
  const rows = JSON.parse(bd(['show', beadId, '--json']));
  bead = (Array.isArray(rows) ? rows : rows?.issues || [])[0] || null;
} catch {
  /* Reported below — a delivery for a bead that does not exist is a typo, not a state. */
}
if (!bead) die(`no bead ${beadId} in the ${ws.name} workspace`);

const summary = summaryFile ? fs.readFileSync(summaryFile, 'utf8') : fs.readFileSync(0, 'utf8').trim();
if (!summary) die(`a summary is required — it is the whole of what ${owner} reads before merging`, 2);

const title = titleArg || `${beadId}: ${bead.title || branch}`;

/* --------------------------------------------------------------------- github */

const gh = await pr.available();
if (!gh.ok) die(gh.reason, 4);

// Push before asking GitHub anything: `gh pr create` on an unpushed branch offers an
// interactive prompt, and there is nobody at this keyboard to answer it.
try {
  git(['push', '--set-upstream', 'origin', `${branch}:${branch}`]);
} catch (err) {
  die(`could not push ${branch} — ${String(err.message).split('\n').slice(-2).join(' ')}`, 5);
}

// Whether this delivery intends to end in a merge. Read before the PR body is built,
// because the body's last line is a promise about what happens next and it has to be
// the right one — a merged PR whose description says it is waiting for approval is a
// small lie that outlives the session by as long as the repo does.
const autoMerge = cfg.pr?.autoMerge !== false && !review;

const prBody = [
  `Closes ${beadId} once merged.`,
  '',
  summary,
  tests ? `\n**Tests:** ${tests}` : '',
  risk ? `\n**Worth knowing:** ${risk}` : '',
  left ? `\n**Left undone:** ${left}` : '',
  '',
  '---',
  autoMerge
    ? `_Opened by a beadcause worker session on ${beadId}, which merges it itself once the checks report. If it is ` +
      `still open, something stopped that — the reason is on ${beadId} and in ${owner}'s inbox._`
    : `_Opened by a beadcause worker session on ${beadId}. It is not merged until ${owner} answers the question in their inbox._`,
]
  .filter((l) => l !== '')
  .join('\n');

// The second delivery on a branch is the ordinary case, not the exception: changes
// were requested, the session pushed more commits, and the PR is still open. Reusing
// it keeps the review thread in one place.
let request = await pr.viewForBranch(dir, branch);
if (request && request.state !== 'OPEN') request = null;
if (request) {
  await pr.comment(dir, request.number, `**Updated** — ${ahead} commit${ahead === 1 ? '' : 's'} on \`${branch}\`.\n\n${summary}`);
} else {
  try {
    request = await pr.create(dir, { base, head: branch, title, body: prBody });
  } catch (err) {
    die(`gh pr create failed — ${err.message}`, 5);
  }
}

/* -------------------------------------------------------------------- the merge */

/**
 * Merge it, or work out the sentence explaining why not.
 *
 * `refused` is the whole interface between this block and everything below it: empty
 * means it merged, anything else is prose that ends up on the card, in the pull
 * request's own thread, and on the bead. So each branch here writes a *complete
 * sentence*, in the vocabulary of the thing that refused rather than of this file —
 * GitHub's own words when GitHub is what said no, the names of the checks when they
 * are, the number of minutes when nothing reported at all. "Could not merge" is the
 * one thing none of them says, because that is the only part Adam can already see.
 *
 * The order is not interchangeable. Checks are consulted *before* `merge()` and can
 * refuse on their own, which is a deliberate difference from the button on the phone:
 * that one lets him merge over a red check on purpose, because a red check is
 * sometimes a flake and judging that is exactly what a human is for. A worker has no
 * business making that call at three in the morning, so failing checks stop it here
 * and become his decision on a card — the same decision, arriving in the one place it
 * can be made properly.
 */
let landed = null;
let refused = '';

if (autoMerge) {
  const waitMs = Math.max(0, Number(cfg.pr?.mergeWaitMs ?? 300000) || 0);
  const { pr: settled, timedOut } = await pr.settle(dir, request.number, { timeoutMs: waitMs });

  if (timedOut) {
    const mins = Math.round(waitMs / 60000);
    refused =
      `${settled.checks.pending} of its ${settled.checks.total} checks were still running after ` +
      `${mins} minute${mins === 1 ? '' : 's'}, so it stopped waiting rather than merge over an unknown.`;
  } else if (settled.checks.state === 'failing') {
    const named = settled.checks.failed.length ? ` (${settled.checks.failed.join(', ')})` : '';
    refused =
      `${settled.checks.failing} check${settled.checks.failing === 1 ? '' : 's'} failing${named}. ` +
      `A worker will not merge over a red check — if it is a flake, that is your call to make.`;
  } else {
    try {
      // `deleteBranch: false`, always, and not a preference: this runs in the worker's
      // own worktree with that branch checked out. `gh` tidies the local branch after
      // the remote one, cannot delete the branch it is standing on, and would turn a
      // merge that worked into a command that failed. The worktree sweep retires the
      // directory once GitHub says the PR landed (lib/tidy.js), and it finds that out
      // by asking about the branch — so the branch outliving the merge is load-bearing.
      landed = await pr.merge(dir, request.number, { method, deleteBranch: false });
    } catch (err) {
      const said = String(err.message || '').trim();
      refused = /[.!?]$/.test(said) ? said : `${said}.`;
    }
  }
}

if (landed) {
  const sha = String(landed.mergeCommit || '').slice(0, 8);
  const where = `#${request.number}${sha ? ` as ${sha}` : ''}`;

  // The bead, in two writes and in this order: the comment is the record of what
  // happened, and the close is the claim that it is finished. Both are wrapped,
  // separately, because the merge has *already happened* — a tracker that would not
  // take the news must not be reported as a delivery that failed, or the next session
  // reads "could not deliver" about work that is in main. Same reason the daemon
  // `.catch`-es this exact close after a tap (lib/server.js).
  // `alreadyMerged` is `pr.merge`'s way of saying it did not have to do anything, and
  // the note says so rather than claiming a merge this run did not perform. Rare — a
  // re-delivery of a branch whose PR merged usually dies at `gh pr create` with no
  // commits between — but "the worker merged it" about a merge that happened yesterday
  // is exactly the kind of small untruth that costs an hour to unpick six months on.
  const how = landed.alreadyMerged ? `was already merged into \`${base}\`` : `${method}-merged into \`${base}\` by the worker session`;
  const note = `Landed as [${where}](${request.url}) — ${how}, on \`${branch}\`.${owed ? ` Still owed: ${owed}.` : ''}`;
  try {
    bd(['comment', beadId, note]);
  } catch (err) {
    console.error(`beadcause-deliver: merged ${where}, but could not comment on ${beadId} — ${first(err)}`);
  }
  try {
    bd(['close', beadId, '--reason', `Landed as ${where}${owed ? ` — still owed: ${owed}` : ''}`]);
  } catch (err) {
    console.error(`beadcause-deliver: merged ${where}, but could not close ${beadId} — ${first(err)}`);
  }

  // A notification with nothing to answer, and a failure to send one is not a failure
  // to land: the work is in main whether or not a phone in another room hears about it.
  try {
    await pushLanded(cfg, {
      workspace: ws.name,
      bead: beadId,
      repo: await pr.slugFor(dir),
      number: request.number,
      url: request.url,
      title: request.title,
      base,
      sha: landed.mergeCommit || '',
      owed,
    });
  } catch (err) {
    console.error(`beadcause-deliver: merged ${where}, but the notification did not send — ${first(err)}`);
  }

  console.log(`landed #${request.number} ${request.url}${sha ? ` ${sha}` : ''}`);
  process.exit(0);
}

// Everything from here down is the older ending, unchanged: it is what a delivery does
// when the merge was refused, when `--review` asked for a human, or when `autoMerge` is
// off. `refused` is empty in the last two, which is how the card knows which it was.
if (refused) console.error(`beadcause-deliver: not merged — ${refused}`);

/* ----------------------------------------------------------- the question bead */

/**
 * Whether this card gets a **Ship it** button, and what it says it will do.
 *
 * Read here rather than at answer time because this is what writes the options, and
 * the options are the whole protocol on the wire — but read *again* by the server
 * before anything deploys, so a declaration removed between filing and answering costs
 * a stale button and never a wrong deploy. Empty for every repo with no `deploys`
 * entry, which is most of them.
 *
 * A broken declaration is caught and dropped rather than thrown: `deployFor` refuses a
 * `command` that is not argv, and that is a good refusal at the moment somebody presses
 * the button. It is a terrible reason to fail a delivery whose branch is already pushed
 * and whose pull request is already open.
 */
let shipHint = '';
try {
  shipHint = deployHint(deployFor(cfg, ws.name));
} catch (err) {
  console.error(`beadcause-deliver: ${ws.name} declares a deploy this cannot read, so the card offers no Ship — ${first(err)}`);
}

const delivery = {
  workspace: ws.name,
  bead: beadId,
  repo: await pr.slugFor(dir),
  number: request.number,
  url: request.url,
  branch,
  base,
  method,
  title: request.title,
  summary,
  tests,
  risk,
  left,
};

const out = bd([
  'create',
  '--title',
  deliveryTitle(delivery),
  '--type',
  'task',
  '--priority',
  '1',
  '--label',
  'human',
  '--label',
  DELIVERY_LABEL,
  '--description',
  deliveryBody(delivery, {
    context: `**${request.files ?? 0} file${request.files === 1 ? '' : 's'}**, +${request.additions ?? 0} −${request.deletions ?? 0}, ${ahead} commit${ahead === 1 ? '' : 's'}.`,
    // Which of the three reasons this card exists. `asked` is deliberately narrower
    // than `review` on its own: with `pr.autoMerge` off, every delivery is a question
    // and `--review` asked for nothing that was not already going to happen, so a card
    // claiming the worker chose this would be crediting it with a decision it never had.
    refused,
    asked: review && cfg.pr?.autoMerge !== false,
    ship: shipHint,
  }),
  '--json',
]);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const questionId = created.id || created.issue?.id;

// The work bead waits behind the question. Without this the advocate's next tick sees
// a bead that is open and unblocked, and opens a second session onto work that is
// already sitting in a PR — the exact duplication the whole channel exists to stop.
try {
  bd(['dep', 'add', beadId, questionId]);
} catch (err) {
  console.error(`beadcause-deliver: filed ${questionId}, but could not park ${beadId} behind it — ${String(err.message).split('\n')[0]}`);
}

try {
  bd([
    'comment',
    beadId,
    `Delivered as [#${request.number}](${request.url}) on \`${branch}\`. Waiting on ${questionId} for the merge.` +
      (refused ? ` The worker tried to merge it and could not: ${refused}` : '') +
      (owed ? ` Still owed after the merge: ${owed}.` : ''),
  ]);
} catch {
  /* The comment is a courtesy; the dependency above is the part that matters. */
}

// And on the pull request itself, because that is where whoever opens the diff is
// standing. A green PR sitting open for two days with nothing on it to say why is the
// state this whole fallback exists to avoid being mysterious about.
if (refused) {
  await pr
    .comment(dir, request.number, `A beadcause worker tried to merge this and could not: ${refused}\n\nIt is now ${owner}'s call — see ${questionId}.`)
    .catch((err) => console.error(`beadcause-deliver: could not comment on #${request.number} — ${first(err)}`));
}

console.log(`${questionId} ${request.url}`);
