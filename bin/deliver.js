#!/usr/bin/env node
/**
 * Land finished work: push it, open the pull request, hand the merge over.
 *
 *   beadcause-deliver -w beadcause -b bc-7qo --tests "npm test — 42 passing" < summary.md
 *
 * This is how a session ends, and it has ended three different ways.
 *
 * It once ended by merging into main on this laptop and closing its bead, which only
 * worked while Adam was the only one who ever merged — with several sessions a day they
 * raced each other into main, and every conflict landed on him anyway, in the worst
 * possible form. So it became a pull request and a question on his phone, and nothing
 * merged until he tapped.
 *
 * That fixed the race and introduced a queue of a different kind. Every finished piece of
 * work waited for *him*: a bead finished at three in the morning sat unmerged until
 * breakfast, and the next bead to touch the same file started from a `main` that did not
 * have it. So the worker got its merge back — this time through `gh`, on the pull
 * request, where GitHub serialises them.
 *
 * **bc-r941 is the third ending, and it is the second one done properly.** What was wrong
 * with a worker merging was never the race, which the pull request had already fixed. It
 * was position: the agent that wrote the code was also the one deciding it was done, and
 * it decided from inside a single worktree. It could not know that three other branches
 * were about to conflict with this one, or that the red check stopping it was red on
 * `main` too (bc-y738, bc-f31f). Every judgement it could not make became a card in
 * Adam's inbox; every judgement it could make it made alone, five times over in five
 * separate processes.
 *
 * So the merge moved to the daemon, and this does five things:
 *
 * 1. Pushes the branch. **Only ever a branch** — this refuses to run on main, and
 *    nothing in beadcause can push to main at all.
 * 2. Opens the pull request, or finds the one already open for the branch, which is
 *    the ordinary case on the second delivery after changes were requested.
 * 3. Files a **merge-bead** (lib/mergebead.js) carrying that pull request, assigned to
 *    the merge queue (lib/mergeadvocate.js).
 * 4. **Parks the work bead behind it**, which is the half that makes the removal
 *    structural rather than a sentence in a brief: the close gate refuses a bead with an
 *    open blocker, so a worker cannot close its own work even if a future brief forgets
 *    to tell it not to.
 * 5. Says so, on the bead and on the pull request, and exits. It prints
 *    `queued #<n> <url> <merge-bead>`.
 *
 * **What it no longer does is merge, or close the work bead.** Both are the queue's, and
 * the queue closes them together when the merge actually lands — because the merge is
 * what makes the work true.
 *
 * **The question card is intact and is still the other ending.** A space with auto-merge
 * off, a session that asked for a human with `--review`, or a bead that came out of edit
 * mode files exactly the card it always filed and parks the bead behind that instead.
 * Those endings were never merges, so nothing about them changed.
 *
 * **And `landHere` survives, for one caller.** A branch that was *already merged on
 * github.com* when this delivery started still closes the bead and the cards here. That
 * is not a worker merging its own work; it is recording a merge somebody else already
 * made, which is the claim `reconcileLanded` in lib/landed.js makes on its own sweep.
 *
 * What it never does is deploy. The merge is on `origin`; whether that is *running* is a
 * separate act with a separate button (the PR board's Ship), because what a deploy even
 * is lives in each repo's CLAUDE.md.
 *
 * Exits non-zero, loudly, on every condition where carrying on would produce a PR that
 * misrepresents what is in the branch — a dirty tree, no commits, a detached head, or a
 * commit carrying an unresolved merge (see `inspectBranch` below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ownAddresseeLabels } from '../lib/addressee.js';
import { isClaimGuard, LIVE_STATUSES } from '../lib/bd.js';
import { bylineFor } from '../lib/byline.js';
import { isMergeReason, parseJson } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { inspectBranch, report as conflictReport } from '../lib/conflicted.js';
import { ownerName } from '../lib/owner.js';
import { cardsForDelivery, deliveryBody, deliveryTitle, DELIVERY_LABEL } from '../lib/delivery.js';
import { deployFor, deployHint } from '../lib/deploy.js';
import { EDIT_HOLD, fromEditMode } from '../lib/editwork.js';
import { landedReason } from '../lib/landed.js';
import { MERGE_ASSIGNEE, MERGE_LABEL, mergeBeadBody, mergeBeadTitle, openMergeBeadFor } from '../lib/mergebead.js';
import { requestSweep } from '../lib/mergesweep.js';
import { pushLanded } from '../lib/notify.js';
import { oweClose } from '../lib/owed.js';
import { park, questionType } from '../lib/park.js';
import * as pr from '../lib/pr.js';
import { baseFor } from '../lib/prbase.js';
import { landParent } from '../lib/prboard.js';
import { bareRefs, diffstat, prBody as renderBody, prTitle } from '../lib/prtext.js';
import { multiRepo, repoUnits } from '../lib/repos.js';
import { prPolicyFor } from '../lib/spaces.js';

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

/**
 * What bd actually said, rather than what node says about the exit code.
 *
 * `execFileSync`'s own message is "Command failed: …" with the whole argv after it,
 * and the argv of a `bd close` includes the entire close reason. The sentence worth
 * repeating on a bead is bd's: *cannot close bc-ec6: blocked by open issues [bc-a0vc]*.
 */
const bdSaid = (err) => {
  const out = String(err?.stderr || '').trim() || String(err?.stdout || '').trim();
  return out ? out.split('\n').filter(Boolean)[0] : first(err);
};

/**
 * squash | merge | rebase, normalised once. An unknown one is a typo, not a request.
 *
 * The fallback is `merge` rather than `squash` for the reason spelled out beside
 * `pr.mergeMethod` in lib/config.js: a squash-merged branch never becomes an ancestor
 * of main, and the worktree cleanup on both sides of this repo tests exactly that. A
 * typo in the config must not quietly land the one method that strands a worktree.
 */
const mergeMethod = (m) => (['squash', 'merge', 'rebase'].includes(m) ? m : 'merge');

const cfg = loadConfig();
// What the pull request body and the argument errors call whoever is reviewing this.
const owner = ownerName(cfg);
const wsName = arg('--workspace', '-w');
const beadId = arg('--bead', '-b');
/**
 * How it lands — the flag, then the config, then the built-in default.
 *
 * The config half was missing, and its absence was invisible because the literal here
 * happened to equal the default over there. `pr.mergeMethod` reached `lib/session.js`,
 * where it shapes the sentence the brief makes about this command ("…**merge**-merges
 * it into `main`"), and reached nothing that merges: setting it to anything at all
 * changed the promise and not the act. Read here, the setting means what it says, and
 * the brief and the command cannot drift apart.
 */
const method = mergeMethod(String(arg('--method') || cfg.pr?.mergeMethod || 'merge').toLowerCase());
/**
 * And *where* it lands, which is no longer one string for the whole install.
 *
 * `--base` still wins outright — a session delivering into something other than its
 * repo's default branch says so on the command line. With no flag the answer comes from
 * `baseFor` in lib/prbase.js: `pr.base` for a workspace that is one repo, and the repo's
 * own default branch for a workspace that is forty of them. One setting cannot name
 * forty bases, and whether they all happen to agree today is not something a delivery
 * should be resting on — a pull request opened into the wrong base is a perfectly valid
 * pull request, so being wrong here is silent.
 */
const baseFlag = arg('--base');
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
    'usage: beadcause-deliver -w <workspace> -b <bead> [--base main] [--method merge] [--tests "..."]\n' +
      '                        [--risk "..."] [--left "..."] [--owed "deploy, rebuild"] [--review] [-f summary.md]'
  );
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const base = baseFlag || (await baseFor(cfg, ws.name, dir));

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
/**
 * Nothing ahead is two different states, and this used to treat both as the failure.
 *
 * "Nothing to deliver" is right for a session that committed nothing. It is exactly
 * wrong for a session whose work is **already in `base`** — which is what a branch looks
 * like once its pull request has been merged on github.com rather than from a card. That
 * merge closes nothing here (see lib/landed.js), so the bead is still open, the advocate
 * hands it out again, and the session it hands it to is told to end with this command…
 * which dies at this line with `exit 2`. The one command a worker is given to land work
 * with could not close the bead over work that had already landed, and the worker was
 * left choosing between disobeying its brief and leaving the bead open for attempt 3.
 *
 * So the check moves past `gh`, below: with no commits ahead, this asks whether the
 * branch's pull request merged. If it did, the bead is closed exactly as a merge here
 * would close it and this exits 0 having landed nothing, which is the truth. If it did
 * not, the original refusal stands, word for word.
 */
const nothingAhead = !ahead;

/**
 * An unresolved merge, or a file that no longer parses — refused here, before anything.
 *
 * git commits conflict markers without a murmur, so a merge commit carrying three of
 * them is indistinguishable from a resolved one at every point between the commit and
 * whoever loads the file. On 2026-08-11 that reached this command: a resolver session
 * committed a re-conflicted `public/console.js` (bc-d2y6) and the only symptom was a
 * test suite failing 38 suites into the gate with `Unexpected token '<<'`, which reads
 * as a regression in the thing being tested rather than as a file that does not parse.
 * One `git push` from a phone being served an unparseable script.
 *
 * Asked of the **committed blobs**, not the working tree — the tree can be clean while
 * the branch is broken, which is exactly what happens when the file is fixed after the
 * commit rather than before it. And asked *first*, ahead of the push, the pull request
 * and the bead: everything below this line writes to `origin` or to Adam's phone, and a
 * refusal is only cheap while nothing has been written anywhere.
 *
 * `lib/conflicted.js` has the rest of the reasoning, including why `=======` is not one
 * of the markers it looks for.
 */
if (ahead) {
  const findings = inspectBranch(dir, { ref: 'HEAD', base: upstream });
  if (findings.length) {
    die(
      `refusing to push ${branch} — ${findings.length} file${findings.length === 1 ? '' : 's'} the commits carry ` +
        `${findings.some((f) => f.kind === 'conflict') ? 'an unresolved merge' : 'a syntax error'}:\n\n` +
        `${conflictReport(findings, { what: 'the commit' })}\n\n` +
        'Install the hook and this is caught at `git commit` instead of here, in every\n' +
        'worktree of this repo: `node scripts/conflict-check.mjs --install-hook`.',
      6
    );
  }
}

/* ------------------------------------------------------------------- the bead */

// The byline this machine files under, on the argv as well as in the environment — a
// workspace `config.yaml` with an `actor:` in it beats `BEADS_ACTOR` and the flag beats
// both, which is why `Bd.run` has always appended it. See bin/ask.js and lib/byline.js.
const byline = bylineFor(cfg);
const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: byline };
const bd = (args) =>
  execFileSync(cfg.bdBin, [...args, '--actor', byline], { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

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

/**
 * The title, through `prTitle` whichever end it came from.
 *
 * `--title` is not trusted more than the bead is. The length discipline in lib/prtext.js
 * is about the four narrow places a pull request title gets read — GitHub's list, an
 * ntfy notification, the delivery card's heading, `Merge #<n>? …` at 160 characters —
 * and none of them cares who wrote the string. A session that hand-writes a good short
 * title is unchanged by this; one that pastes the bead's own 118-character sentence in
 * gets the same clause taken off the front that the default would have got.
 */
const title = prTitle(beadId, titleArg || bead.title || branch);

/* --------------------------------------------------------------------- github */

const gh = await pr.available();
if (!gh.ok) die(gh.reason, 4);

/**
 * And this particular checkout — because `gh` being installed says nothing about
 * whether *this* repo has a GitHub remote any account here can see.
 *
 * It used to be found out two steps later, by `git push` failing on a missing
 * `origin` or by `gh pr create` failing on a repo it cannot resolve. Both of those name
 * the remote and neither names the repo, which was fine while a workspace was one
 * checkout and the repo was never in doubt. In a workspace of forty it is exactly the
 * half you need, so it is asked here — before the push, while a refusal is still free —
 * and the slug is kept, because resolving it is a `gh` call and it is wanted twice more
 * below.
 */
const slug = await pr.slugFor(dir);
if (!slug) {
  die(
    `no GitHub repo is visible from ${dir} — nothing there opens pull requests. ` +
      `The work is committed on ${branch}; say so on ${beadId} and leave it there.`,
    4
  );
}

/**
 * A `#123` written in a workspace of forty repos is a link to the wrong repo.
 *
 * GitHub resolves a bare `#N` against the repo the body is in, whatever the words around
 * it say and whatever full URLs share the line — so in a workspace that is one checkout
 * it means what it says, and in one that is forty it silently links a sentence about
 * another service to an unrelated pull request in this one. That is the failure worth
 * catching: it renders, so nobody looks at it.
 *
 * Said, and not refused. It is a mistake in prose; the branch is finished and correct,
 * and dying over a hyperlink would strand real work. Said *here*, after the slug is
 * resolved and before anything is pushed, so the line can name the repo the link would
 * actually go to — which is the half that makes it obvious rather than pedantic.
 */
if (multiRepo(cfg, ws.name)) {
  const bare = bareRefs(`${summary}\n${tests}\n${risk}\n${left}`);
  if (bare.length) {
    console.error(
      `beadcause-deliver: ${bare.join(', ')} in the summary will link to ${slug}, not to the repo you meant — ` +
        'a pull request in another repo needs its full https://github.com/<owner>/<repo>/pull/<n> url.'
    );
  }
}

/**
 * The pull request this delivery is about, and the repo it is in.
 *
 * Module-scope and assigned rather than declared where they are first used, because
 * `landHere` below is reached from two places — the merge this run performs, and the
 * merge somebody else already performed — and it should read the same pull request
 * either way rather than take it as an argument nobody can get wrong only once.
 */
let request = null;
let repoSlug = null;

/**
 * The merged pull request for this branch, or null.
 *
 * Two questions, because they fail in different places. `gh pr view <branch>` is the
 * direct answer and usually right; it is also the one that goes missing once the branch
 * has been deleted, which is exactly what a card merge does (`deleteBranch: true`). So a
 * miss falls back to the merged list and matches on the head ref, which GitHub keeps
 * long after the branch itself is gone.
 *
 * **The fallback asks GitHub for the branch, not for the newest N pull requests**, and
 * that is bc-kbr6. It used to ask for forty merges and match the head ref here — forty
 * being under a day on this repo, where 120 merged in one day and 152 in two. So the
 * one case the fallback exists for, a branch merged from a card and deleted, was
 * answered correctly for a few hours and then not at all: the delivery fell through to
 * `<branch> has no commits that origin/<branch> does not` and exit 2, over work that had
 * landed. `--head` moves the match into the query, so the answer does not depend on how
 * much else merged after it and there is no window to get wrong. The limit stays as a
 * guard against a runaway answer: one branch has one pull request, or a handful if it
 * was reopened, never twenty.
 *
 * The client-side match is kept underneath it deliberately. It is one `find` over at
 * most twenty rows, and it means a `gh` that ignored the flag — an old build, a future
 * one that renames it — narrows the answer wrongly rather than returning somebody
 * else's pull request as this branch's.
 */
async function mergedPrFor(head) {
  const direct = await pr.viewForBranch(dir, head);
  if (direct && direct.state === 'MERGED') return direct;
  try {
    const rows = await pr.list(dir, { state: 'merged', head, limit: 20 });
    return (rows || []).find((r) => r.branch === head && r.state === 'MERGED') || null;
  } catch {
    // `gh` refusing the list is not evidence that nothing merged, but it is all the
    // evidence there is, and the caller's fallback is the honest refusal it always gave.
    return null;
  }
}

/**
 * Nothing to push and nothing to open: this branch is already in `base`.
 *
 * Handled before the push, and that ordering is the load-bearing part. `git push
 * --set-upstream` on a branch whose remote was deleted by the merge would *recreate* it
 * — resurrecting, from a laptop, a branch GitHub deleted on purpose — and `gh pr create`
 * with no commits between the two refs fails anyway. So the question is asked here,
 * before anything is written to origin at all.
 */
if (nothingAhead) {
  const merged = await mergedPrFor(branch);
  if (!merged) die(`${branch} has no commits that ${upstream} does not — there is nothing to deliver`, 2);
  request = merged;
  repoSlug = slug;
  console.error(
    `beadcause-deliver: nothing to push — #${merged.number} was already merged into ${base}. Closing ${beadId} over it.`
  );
  await landHere(merged, { external: true });
}

// Push before asking GitHub anything: `gh pr create` on an unpushed branch offers an
// interactive prompt, and there is nobody at this keyboard to answer it.
try {
  git(['push', '--set-upstream', 'origin', `${branch}:${branch}`]);
} catch (err) {
  die(`could not push ${branch} — ${String(err.message).split('\n').slice(-2).join(' ')}`, 5);
}

// Whether this delivery intends to end in a merge, and on what terms. Read before the
// PR body is built, because the body's last line is a promise about what happens next
// and it has to be the right one — a merged PR whose description says it is waiting for
// approval is a small lie that outlives the session by as long as the repo does.
//
// Resolved per *space* rather than off `cfg.pr` directly, and through the same helper
// `lib/session.js` uses to write the brief: the brief promises what this command will
// do, and the two reading different answers is how a window reports work as landed over
// a bead that says otherwise.
const policy = prPolicyFor(cfg, ws.name);
/**
 * Whether this bead may be merged by the thing that wrote it, which for one kind of bead
 * is no.
 *
 * A bead filed from inside the running app (lib/edits.js) is a sentence Adam said to a
 * screen, and the whole of its review is him looking at what came back — so the epic that
 * built it says outright that nothing on that path reaches main without a human approval
 * (bc-p49x.4). The worker's brief says the same thing and asks for `--review`; this is
 * what makes it true. A brief is a promise about what a command will do, and a promise a
 * session can forget to keep is not a guarantee: the flag going missing, or a future
 * brief quietly dropping the sentence, must not be able to land an unreviewed in-app edit.
 *
 * Every bead carrying the label, not only the leaf edits — the pass and the standing root
 * carry it too, and neither is a thing to deliver against at all. Holding one is the
 * harmless direction.
 */
const editHold = fromEditMode(bead);
if (editHold) console.error(`beadcause-deliver: ${beadId} is an in-app edit, so this delivery asks rather than merges.`);
const autoMerge = policy.autoMerge && !review && !editHold;
// Green checks are not enough in a space that asks for a review first. Only consulted
// inside the `autoMerge` branch below — with auto-merge off every delivery is already a
// question, and answering it *is* the approval.
const requireApproval = policy.requireApproval;

/**
 * What the branch actually changed, asked of the branch rather than of the summary.
 *
 * The three-dot form is deliberate and is the whole point: `<upstream>...HEAD` diffs
 * against the merge base, so a branch that merged main in last night reports what *it*
 * did and not what main did while it was open. Two dots would put a fortnight of other
 * people's work in this pull request's description.
 *
 * Best-effort. A diffstat is worth having and is worth nothing at all compared to the
 * delivery: a git invocation that fails here — an object it cannot read, a base ref that
 * has gone — must not be the reason a finished piece of work does not reach `origin`.
 */
let stat = null;
try {
  stat = diffstat(git(['diff', '--numstat', `${upstream}...HEAD`]));
} catch (err) {
  console.error(`beadcause-deliver: no diffstat for the body — ${first(err)}`);
}

const prBody = renderBody({
  beadId,
  beadTitle: bead.title || '',
  title,
  summary,
  tests,
  risk,
  left,
  stat,
  base,
  owner,
  autoMerge,
  requireApproval,
  editHold,
});

// The second delivery on a branch is the ordinary case, not the exception: changes
// were requested, the session pushed more commits, and the PR is still open. Reusing
// it keeps the review thread in one place.
request = await pr.viewForBranch(dir, branch);
if (request && request.state !== 'OPEN') request = null;
if (request) {
  /**
   * A redelivery says what changed *this time*, in a comment, and leaves the description
   * where it is.
   *
   * That split is on purpose. The body is what the first reviewer read and what a review
   * comment is anchored against; rewriting it under them turns "I asked about the second
   * paragraph" into a sentence about a paragraph that is no longer there. A comment is
   * additive and dated, and the thread is where a second round belongs.
   *
   * The **title** is the exception, and the one the skill in agent-context is explicit
   * about: it must reflect the final diff, and a bead retitled mid-flight — which happens
   * here, because a session that learns what the work really was says so on the bead —
   * leaves the pull request advertising the wrong thing on a board Adam reads without
   * opening anything. Nothing is lost by correcting it, so it is corrected, and it is not
   * a reason to fail a delivery that has already pushed.
   */
  if (request.title && request.title !== title) {
    try {
      await pr.retitle(dir, request.number, title);
      console.error(`beadcause-deliver: retitled #${request.number} — ${title}`);
      request = { ...request, title };
    } catch (err) {
      console.error(`beadcause-deliver: could not retitle #${request.number} — ${first(err)}`);
    }
  }
  const changed = stat?.files?.length
    ? ` — ${stat.files.length} file${stat.files.length === 1 ? '' : 's'}, +${stat.added} −${stat.removed} against \`${base}\``
    : '';
  await pr.comment(
    dir,
    request.number,
    `**Updated** — ${ahead} commit${ahead === 1 ? '' : 's'} on \`${branch}\`${changed}.\n\n${summary}` +
      `${tests ? `\n\n**Tests:** ${tests}` : ''}${risk ? `\n\n**Worth knowing:** ${risk}` : ''}${left ? `\n\n**Left undone:** ${left}` : ''}`
  );
} else {
  try {
    request = await pr.create(dir, { base, head: branch, title, body: prBody });
  } catch (err) {
    die(`gh pr create failed — ${err.message}`, 5);
  }
}

/* ------------------------------------------------- the cards already open on it */

repoSlug = slug;

/**
 * Close every merge card already open for this pull request, before this delivery
 * adds anything of its own.
 *
 * One card per attempt is the design and it is a good one — a delivery question
 * closes on all four of its answers, and the next push files a fresh one, so the
 * inbox carries one card per attempt rather than one card that quietly changes
 * meaning under you. What it assumed was that every attempt follows an *answer*.
 *
 * bc-ec6 was delivered three times inside twenty minutes with nobody at the phone.
 * Three cards, two of them open together, carrying an identical title and an
 * identical body — and it was answered twice, a minute apart, each answer claiming
 * to have closed the work bead. Neither could: the two cards were both blockers on
 * that bead's close, so the first answer was refused by the second card and the
 * second answer was refused by nothing, having already been reported as done. The
 * work bead sat `in_progress` over a merged pull request.
 *
 * So the invariant is enforced here rather than assumed: never two open cards for
 * one pull request, and never two dependencies on one work bead. It runs on both
 * endings, because both make the old card meaningless — a re-delivery replaces it,
 * and a merge answers it outright.
 *
 * The cards it looks for are the ones for this pull request **or for this bead** —
 * see `cardsForDelivery`. The bead half catches the pile the number cannot see: a
 * session that abandoned its branch and delivered the same work on a new one, whose
 * first card is still in the inbox pointing at a pull request nobody will merge. Its
 * close reason names that older request, because "superseded" about a different
 * number reads as a mistake unless it says which.
 *
 * Everything in here is best-effort and none of it throws. The branch is pushed and
 * the pull request is open by the time this runs; a workspace that will not answer
 * `bd list` is a reason to leave a stale card behind, not to fail a delivery.
 */
function clearOpenCards(why) {
  return clearOpen(DELIVERY_LABEL, cardsForDelivery, why);
}

/**
 * And the same for the merge-bead, which needs it more.
 *
 * A delivery card left open twice was two questions in the inbox, each a blocker on the
 * work bead's close — bad, and visible. A *merge-bead* left open twice is two entries in
 * the queue for one pull request, each a blocker on the same work bead, and the queue
 * would merge the first and then find the second unmergeable forever. So the same sweep,
 * with the same matcher shape, over the label that marks a queue entry.
 *
 * One function taking the label and the matcher rather than two copies, because the two
 * copies would drift on the day somebody fixes the matching in one of them.
 */
function clearOpen(label, find, why) {
  let rows;
  try {
    rows = parseJson(bd(['list', '--label', label, '--status=open,in_progress,blocked', '--limit', '0', '--json'])) || [];
  } catch (err) {
    console.error(`beadcause-deliver: could not look for ${label} beads already open on ${beadId} — ${bdSaid(err)}`);
    return [];
  }

  const cleared = [];
  for (const card of find(rows, { repo: repoSlug, number: request.number, bead: beadId })) {
    // A card matched on the bead rather than on the number is about an older pull
    // request, and the reason has to say so or it reads as the wrong card being closed.
    const reason =
      card.number && card.number !== request.number
        ? `${why} That card asked about #${card.number}, which ${beadId} is no longer being delivered on.`
        : why;
    try {
      bd(['close', card.id, '--reason', reason]);
    } catch (err) {
      /**
       * Over the claim guard, and only over the claim guard — bc-r941, and the same
       * refusal bc-9d37.13 hit at the other close in this file.
       *
       * A merge-bead is *assigned*, to `merge-advocate`, because that is how the queue
       * finds it. bd 1.2.1 refuses a close by anybody who is not the assignee, so a
       * superseded merge-bead could not be closed by the delivery that superseded it —
       * and the pile that leaves is not cosmetic: every one of them is an open blocker on
       * the work bead, so a bead delivered three times can never be closed by anything.
       *
       * `isClaimGuard` rather than a blanket `--force`, because `--force` also lifts open
       * children, live blockers and the epic gates. Anything else that refuses still
       * travels out to the log below exactly as it did.
       */
      if (!isClaimGuard(err)) {
        console.error(`beadcause-deliver: ${card.id} is still open on ${beadId} — ${bdSaid(err)}`);
        continue;
      }
      try {
        bd(['close', card.id, '--reason', reason, '--force']);
      } catch (forced) {
        console.error(`beadcause-deliver: ${card.id} is still open on ${beadId} — ${bdSaid(forced)}`);
        continue;
      }
    }
    cleared.push(card.id);
    // And the edge it parked the work bead behind. Closing the card is already
    // enough to stop it blocking — bd only counts open blockers — but a work bead
    // ending up with a dependency on each of three dead cards is the residue of
    // this bug and reads, months later, as though the work really had waited on all
    // three. It is one call and it leaves the graph saying what happened.
    const parked = card.bead || beadId;
    try {
      bd(['dep', 'remove', parked, card.id]);
    } catch {
      /* No such edge, or bd would not take it. The card is closed either way. */
    }
  }
  if (cleared.length) console.error(`beadcause-deliver: closed ${cleared.join(', ')} — already open on ${beadId} / #${request.number}`);
  return cleared;
}

/**
 * Which approved repo this worktree belongs to — `''` when none does.
 *
 * A worktree is not a checkout: it has its own directory and shares the object database
 * of the repo it was cut from, so the only honest way to ask is `git rev-parse
 * --git-common-dir` and match what comes back against the approved list.
 *
 * Two callers, both of which need the same answer for different halves of the ending.
 * The card's **Ship** needs it to name a deploy (`deployFor` takes this key, and a bare
 * workspace key in a workspace of forty repos is refused rather than resolved). The
 * merge needs it because the conflict sweep is keyed the same way — see lib/mergesweep.js
 * — and a sweep asked for under the wrong key would be a sweep of a different service.
 * One function rather than two copies, because the copies would drift on the day
 * somebody moves a repo.
 */
function unitKeyHere() {
  const units = repoUnits(cfg, ws.name);
  if (units.length === 1 && !units[0].repo) return units[0].key;
  // Relative (`.git`) or absolute depending on git's version and where it is run, so it is
  // resolved against this directory either way; a git that will not answer leaves `common`
  // as this directory, which matches nothing and is reported by the caller rather than
  // guessed at.
  let common = path.resolve(dir);
  try {
    common = path.resolve(dir, git(['rev-parse', '--git-common-dir']), '..');
  } catch {
    /* not a checkout, or a git that refused — handled by finding no unit */
  }
  const mine = units.find((u) => u.repo && path.resolve(u.repo.dir) === common);
  return mine ? mine.key : '';
}

/* ------------------------------------------------------- the merge, handed over */

/**
 * Nothing here merges any more — bc-r941, and the removal is the point of it.
 *
 * What used to stand in this space was the whole of the worker's own merge: wait for the
 * checks, compare them against nothing, ask GitHub to merge, then close the work bead. It
 * was reached on every ordinary delivery, and it was the agent that wrote the code
 * deciding that the code was done.
 *
 * The judgement it made was not *wrong*; it was made from the worst possible position. A
 * worker sees one branch. It cannot know that three other branches are about to conflict
 * with this one, that the red check stopping it is red on `main` too (bc-y738), or that
 * the same conflict was resolved on a different branch an hour ago. Every judgement it
 * could not make became a card in Adam's inbox, and every judgement it could make it made
 * alone, at three in the morning, five times over in five separate processes.
 *
 * So the merge moved to the daemon, where there is one registry, one queue and one merge
 * at a time per repo (lib/mergeadvocate.js). What a worker does now is hand it over: file
 * a merge-bead carrying the pull request, park its own bead behind it, and stop. The
 * `beadpr` block below is unchanged and is the same block the queue reads.
 *
 * **Two things deliberately did not move with it.** `landHere` is still here, and still
 * closes the work bead, for the one caller that is left: a branch that was *already
 * merged on github.com* when this delivery started. That is not a worker merging its own
 * work — it is recording a merge somebody else already made, which is the same claim
 * `reconcileLanded` in lib/landed.js makes on its own sweep. And the question card is
 * still filed exactly as it was for every delivery that is not auto-merged: `--review`,
 * an in-app edit, or a space with auto-merge off. Those endings were never merges.
 */

/**
 * The bead, the cards, the notification, and the exit — everything that follows a merge
 * having happened, wherever it happened.
 *
 * Two callers. The ordinary one is the merge this run just performed, below. The other
 * is a branch that was already in `base` when this started, because its pull request was
 * merged on github.com — and that caller is the whole reason this is a function rather
 * than the straight-line block it was. Both endings are the same five writes in the same
 * order, and a second copy of them is how one of the two quietly stops closing cards.
 *
 * `external` changes only what is *said*: what merged this is a fact about the world and
 * the bead should record it. It never changes what is done — the bead closes, the cards
 * close, the phone hears about it, and the exit is 0, because the work is in `base`.
 */
async function landHere(landed, { external = false } = {}) {
  const sha = String(landed.mergeCommit || '').slice(0, 8);
  const where = `#${request.number}${sha ? ` as ${sha}` : ''}`;

  /**
   * This Mac's own `base`, which the merge has just left a commit behind.
   *
   * First, because everything after it is a *record* of what happened and this is the
   * last thing that happens. The merge is on `origin`; the laptop finds out about it
   * when something fetches, and until then every `git worktree add` here branches from
   * before this delivery — which is how a session two hours from now ends up doing a
   * downmerge nobody asked for, of work it has never heard of.
   *
   * The act itself is `landLocally`'s, unchanged, aimed at the main checkout rather
   * than this worktree — including the part that matters most, which is that it does
   * **not** touch a checkout with edited work in it. Adam edits in these while
   * sessions run. Untracked residue is the exception it steps past, named in the note
   * either way (bc-45g8).
   *
   * Nothing about it can fail a delivery. The merge has already happened, the work is
   * on `origin` whatever this checkout does, and a laptop that is a commit behind is
   * the state this whole function is an improvement on rather than a regression from.
   */
  let followed = null;
  try {
    followed = await landParent(dir, base);
    console.error(`beadcause-deliver: ${followed.note}`);
  } catch (err) {
    console.error(`beadcause-deliver: merged ${where}, but could not bring local ${base} up — ${first(err)}`);
  }

  /**
   * And every *other* branch still open on this base, which this merge has just measured
   * against a base it has never seen — see lib/mergesweep.js.
   *
   * Recorded for the daemon rather than swept here, and that is not a convenience. The
   * registry that stops two resolver windows opening on one pull request is in the
   * daemon's memory (lib/resolvers.js, deliberately: a window handle is worth as long as
   * the iTerm holding it). This is a different process, so a sweep run here would start
   * from an empty registry — it cannot see the resolver the daemon opened ten minutes
   * ago, so it would open a second one on the same branch, which is bc-utyr — and then
   * `process.exit(0)` below would take any queue it had built with it.
   *
   * No key means this worktree belongs to no approved repo, which is the same state that
   * costs the card its Ship: the daemon could not resolve a checkout for it either, so
   * asking would only fill the log with a request nothing can act on.
   */
  const sweepKey = unitKeyHere();
  if (sweepKey) requestSweep({ workspace: ws.name, key: sweepKey, number: request.number, base, why: `a worker's own delivery of ${beadId}` });
  else console.error(`beadcause-deliver: merged ${where}, but ${dir} is no approved ${ws.name} repo, so nothing will sweep the branches behind it`);

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
  const how = external
    ? `was merged into \`${base}\` on GitHub rather than from a delivery card, so nothing closed this at the time`
    : landed.alreadyMerged
      ? `was already merged into \`${base}\``
      : `${method}-merged into \`${base}\` by the worker session`;
  const note =
    `Landed as [${where}](${request.url}) — ${how}, on \`${branch}\`.${owed ? ` Still owed: ${owed}.` : ''}` +
    // What this Mac's checkout did about it, in landLocally's own words. On the bead
    // rather than only in a session log because "left main where it is — there is
    // uncommitted work in beadcause: lib/foo.js" is the one outcome somebody has to act
    // on, and a session log is read by nobody once its window is closed.
    (followed?.note ? ` This Mac's checkout: ${followed.note}.` : '');
  try {
    bd(['comment', beadId, note]);
  } catch (err) {
    console.error(`beadcause-deliver: merged ${where}, but could not comment on ${beadId} — ${first(err)}`);
  }

  // The card from an earlier attempt, if there was one — closed *before* this bead is,
  // because it is what would refuse the close. "Merge #25?" over a merged #25 is a
  // question with no answer left in it, and it is a blocker on the bead below.
  clearOpenCards(
    external
      ? `${where} was merged on GitHub — nothing left to answer.`
      : `The worker merged ${where} itself on a later delivery — nothing left to answer.`
  );

  // `Landed as #42` is read back by lib/advocate.js to say a *session* merged its own
  // pull request, which is not what happened when GitHub's own merge button did — so the
  // externally-merged wording is lib/landed.js's, the one place that sentence is written,
  // and the advocate reads both. See `reconcile` there.
  const closeReason = external
    ? `${landedReason(request, base)}${owed ? ` — still owed: ${owed}` : ''}`
    : `Landed as ${where}${owed ? ` — still owed: ${owed}` : ''}`;
  // An epic is the one bead this close is wrong about, and bd will not say so: `Adopts:`
  // is prose, so an epic that claims twenty-three beads still has no children as far as
  // bd is concerned and closes on any reason at all. That is how bc-ka5y closed as
  // "Merged #212 as 72789c0b into main" with twenty-one adoptees open, taking its
  // classification of them with it. An umbrella epic is finished when its theme is, which
  // this merge says nothing about — so the merge is left as the comment written above and
  // the epic stays open. Not owed either (lib/owed.js): the retry would carry the same
  // sentence into the same refusal every thirty seconds for as long as the machine runs.
  //
  // The claim is left on it deliberately. A worker's bead is `in_progress` and assigned
  // by the time it gets here, and `bd ready` skips an assigned bead — so an epic left
  // open *and claimed* stays out of the advocate's queue, where an open unclaimed one
  // would be handed straight to another session to deliver and be refused again. Closing
  // it was the old way out of that loop, and it is the thing this rule exists to stop.
  const epicStaysOpen = bead.issue_type === 'epic' && isMergeReason(closeReason);
  if (epicStaysOpen) {
    console.error(
      `beadcause-deliver: merged ${where}, and left ${beadId} open — an epic does not close on a merge. ` +
        `Close it when its theme is done.`
    );
    try {
      bd([
        'comment',
        beadId,
        `This epic stays **open** over ${where}: an epic closes when its theme is done, not when a branch sharing its name merges.`,
      ]);
    } catch {
      /* The comment above this block already says what landed; this one is why it is still open. */
    }
  } else {
    /**
     * Close the work bead, stepping over bd 1.2.1's claim guard but nothing else.
     *
     * This process runs `bd` with the `beadcause (…)` byline while the bead is assigned
     * to the git identity that claimed it, so from 2026-08-14 every delivery was refused
     * its own close — bc-9d37.13. `--force` lifts that, and it lifts open children, live
     * blockers and the epic gates with it, so it is reached for **only** when the claim
     * guard is what refused; anything else still travels out to `oweClose` below exactly
     * as it did. `isClaimGuard` is imported from lib/bd.js rather than re-written here so
     * the two processes cannot disagree about what that refusal looks like.
     *
     * And the other half, which is not about a refusal at all: **a zero exit is not a
     * close.** bc-q6qc — a merged bead took the comment written immediately before its
     * close and stayed `in_progress` for a day, with nothing in the log, nothing in
     * `owed-closes.json` and every layer above reporting the close as done. `bd` came back
     * 0 and the row did not move, and there is no exit code, stream or exception in which
     * that is distinguishable from success. So the close is *asked about* rather than
     * assumed, one `bd show` on a path that has already spent a dozen subprocesses.
     *
     * `Bd.assertClosed` in lib/bd.js is the same check on the daemon's side of the same
     * failure; this is a separate process shelling out to `bd` synchronously, which is why
     * it is a second implementation rather than an import, and why it stays this small.
     * Both fail towards believing the close — an unreadable tracker or a status neither
     * has heard of is not evidence, because inventing a failure here would park a landed
     * bead in `owed-closes.json` to be retried for ever.
     */
    const stillOpen = () => {
      try {
        const rows = JSON.parse(bd(['show', beadId, '--json']));
        const row = (Array.isArray(rows) ? rows : rows?.issues || [])[0] || null;
        if (!row) return '';
        const status = String(row.status || '').trim().toLowerCase();
        return LIVE_STATUSES.has(status) ? status : '';
      } catch {
        return '';
      }
    };
    const mustHaveClosed = () => {
      const status = stillOpen();
      if (status) throw new Error(`bd exited 0 closing ${beadId} and the bead is still ${status} — the close did not happen`);
    };

    const closeWorkBead = () => {
      try {
        bd(['close', beadId, '--reason', closeReason]);
        mustHaveClosed();
      } catch (err) {
        // Not widened to the silent case, for lib/bd.js's reason: `--force` lifts the
        // blocker, children and epic gates too, and a close bd said nothing about is a
        // close nobody can explain. That one goes out to `oweClose` below instead.
        if (!isClaimGuard(err)) throw err;
        console.error(`beadcause-deliver: closing ${beadId} over the claim guard — ${where} is merged`);
        bd(['close', beadId, '--reason', closeReason, '--force']);
        mustHaveClosed();
      }
    };
    try {
      closeWorkBead();
    } catch (err) {
      // A refused close is a state, not a rumour: it is written down where the daemon
      // will retry it once whatever is blocking it clears (lib/owed.js), and said on the
      // bead in bd's own words. Reporting it as done — which is what the tap on the phone
      // used to do — is how bc-ec6 stayed open over a merged pull request with two
      // separate comments claiming otherwise.
      const why = bdSaid(err);
      console.error(`beadcause-deliver: merged ${where}, but could not close ${beadId} — ${why}`);
      oweClose({ workspace: ws.name, id: beadId, reason: closeReason, why });
      try {
        bd(['comment', beadId, `This is merged and this bead did **not** close: ${why}. beadcause retries the close once that clears.`]);
      } catch {
        /* The record above is the part that matters; the comment is the courtesy. */
      }
    }
  }

  // A notification with nothing to answer, and a failure to send one is not a failure
  // to land: the work is in main whether or not a phone in another room hears about it.
  try {
    await pushLanded(cfg, {
      workspace: ws.name,
      bead: beadId,
      repo: repoSlug,
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

// Everything from here down is one of two endings, and `autoMerge` picks between them.
// With it on, the pull request goes on the merge queue and the worker is finished. With
// it off — or with `--review`, or over an in-app edit — the delivery files the same
// question card it always filed, and the merge is Adam's tap. Neither ending merges
// anything here.

/**
 * What was delivered, in the one shape both endings are written from.
 *
 * Above the fork rather than inside each branch, because the two endings differ in *who
 * is asked* and in nothing else: a merge-bead and a question card carry the same `beadpr`
 * block, written by the same serialiser in lib/delivery.js, and the queue's failure path
 * turns the first into the second without re-deriving a field. Two literals here would be
 * two field lists to drift, and the drift would surface as a card whose Merge button acts
 * on a pull request the bead no longer names.
 */
const delivery = {
  workspace: ws.name,
  bead: beadId,
  repo: repoSlug,
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

/* ------------------------------------------------------------- the merge-bead */

/**
 * The ordinary ending since bc-r941: hand the pull request to the merge queue and stop.
 *
 * Three writes, in an order chosen for what survives each one failing:
 *
 * 1. **Supersede** whatever is already open on this pull request — an older merge-bead
 *    from a re-delivery nobody has got to, and any question card from a delivery made
 *    back when this space had auto-merge off. Both are blockers on the work bead by
 *    construction, and two of either is the pile `clearOpenCards` was written for. First,
 *    so a create that fails after it leaves no queue entry rather than two.
 * 2. **File the merge-bead.** Labelled, assigned, and carrying the block. Not `human`:
 *    this is work for an agent, and a bead in Adam's inbox saying "a queue will get to
 *    this" is a notification pretending to be a question.
 * 3. **Park the work bead behind it.** This is the half that makes the removal
 *    structural. The close gate refuses a bead with an open blocker, so from here the
 *    worker *cannot* close its own work even if a future brief forgets to tell it not to
 *    — which is the difference between a rule and a guarantee. `park` is the same call
 *    the question card already used, with `label: false` for the same reason: the work
 *    bead is about to be closed by the merge, and a `human` label nothing takes back off
 *    would strand it in the inbox as a card with no question on it.
 *
 * It prints `queued #<n> <url> <merge-bead>` — deliberately not `landed`, because nothing
 * has landed, and a session that reads one as the other reports work as shipped over a
 * branch still sitting in a pull request.
 */
if (autoMerge) {
  const supersededMerges = clearOpen(
    MERGE_LABEL,
    openMergeBeadFor,
    `Superseded by a later delivery of #${request.number} — the newer merge-bead is the queue's.`
  );
  const supersededCards = clearOpenCards(
    `Superseded by a later delivery of #${request.number}, which went on the merge queue instead.`
  );
  const replaced = [...supersededMerges, ...supersededCards];

  const out = bd([
    'create',
    '--title',
    mergeBeadTitle(delivery),
    '--type',
    'task',
    // Above the work it gates, so a queue that is behind is visible on the board rather
    // than buried under the beads waiting on it.
    '--priority',
    '1',
    '--label',
    MERGE_LABEL,
    '--assignee',
    MERGE_ASSIGNEE,
    ...ownAddresseeLabels(cfg).flatMap((l) => ['--label', l]),
    '--description',
    mergeBeadBody(delivery, { tests }),
    '--json',
  ]);
  const filed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  const mergeId = filed.id || filed.issue?.id;

  const { parked, note } = park(bd, beadId, mergeId, { label: false });
  if (!parked) {
    // Loud, and not fatal. The pull request is open and the merge-bead is filed, so the
    // work still lands — what is lost is the guarantee that this session cannot close its
    // own bead, which is worth a line somebody will read in the log.
    console.error(`beadcause-deliver: ${beadId} is NOT parked behind ${mergeId} — ${note}`);
  }

  try {
    bd([
      'comment',
      beadId,
      `Delivered as [#${request.number}](${request.url}) on \`${branch}\`. It is on the merge queue as ${mergeId}, ` +
        `which brings \`${base}\` into the branch, checks what ${base} is not already failing, merges, and closes this bead.` +
        (replaced.length
          ? ` It replaces ${replaced.join(', ')}, which asked the same thing and ${replaced.length === 1 ? 'was' : 'were'} never answered.`
          : '') +
        (owed ? ` Still owed after the merge: ${owed}.` : ''),
    ]);
  } catch {
    /* The comment is a courtesy; the dependency above is the part that matters. */
  }

  await pr
    .comment(
      dir,
      request.number,
      `A beadcause worker opened this and does not merge its own work. It is on the merge queue as ${mergeId}.`
    )
    .catch((err) => console.error(`beadcause-deliver: could not comment on #${request.number} — ${first(err)}`));

  console.log(`queued #${request.number} ${request.url} ${mergeId}`);
  process.exit(0);
}


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
/**
 * And **which repo's** deploy, which in a workspace of forty checkouts is not the
 * workspace's. This session is standing in a worktree of one of them, so the unit is the
 * one whose checkout owns this worktree's object database — `git rev-parse
 * --git-common-dir`, which is what `landParent` above already asks for the same reason.
 *
 * A worktree that matches no approved repo gets no hint and no Ship, said out loud: it is
 * the same state as a repo that declared nothing, and inventing the workspace's key for it
 * would put a button on the card that deploys a checkout this branch was never in.
 */
const shipKey = unitKeyHere();
if (!shipKey) {
  console.error(
    `beadcause-deliver: ${dir} is not an approved ${ws.name} repo, so the card offers no Ship — ` +
      `add it to repos.${ws.name}.approved if a deploy of it should be one tap`
  );
}

let shipHint = '';
try {
  shipHint = shipKey ? deployHint(deployFor(cfg, shipKey)) : '';
} catch (err) {
  console.error(`beadcause-deliver: ${shipKey} declares a deploy this cannot read, so the card offers no Ship — ${first(err)}`);
}

// Before the new card exists, so the inbox is never holding two questions about the
// same pull request at once. Deliberately before rather than after: a `bd create` that
// fails after this leaves no card, which is the recoverable state the advocate already
// knows how to handle, while a close that fails after a create leaves exactly the two
// open cards this is here to prevent.
const superseded = clearOpenCards(`Superseded by a later delivery of #${request.number} — answer the newer card.`);

// Typed after the bead it is about to park, because bd will only let an epic be
// blocked by another epic (lib/park.js) — and an epic is delivered like anything
// else. Off the row `show` already returned rather than a second lookup. Nothing here
// reads the card's type: every caller finds these by DELIVERY_LABEL.
const cardType = questionType(bead.issue_type);

const out = bd([
  'create',
  '--title',
  deliveryTitle(delivery),
  '--type',
  cardType,
  '--priority',
  '1',
  '--label',
  'human',
  '--label',
  DELIVERY_LABEL,
  // Whose merge this is, when a tracker is shared: the machine the worker ran on. A
  // delivery is the clearest case there is — the branch is on this laptop and the
  // session that wrote it was opened here. Nothing at all when `me` is unset, which is
  // every single-person install; see lib/addressee.js.
  ...ownAddresseeLabels(cfg).flatMap((l) => ['--label', l]),
  '--description',
  deliveryBody(delivery, {
    context: `**${request.files ?? 0} file${request.files === 1 ? '' : 's'}**, +${request.additions ?? 0} −${request.deletions ?? 0}, ${ahead} commit${ahead === 1 ? '' : 's'}.`,
    // `refused` and `approval` are deliberately not passed, and their absence is a fact
    // about this file rather than an omission: since bc-r941 nothing here merges, so
    // nothing here can be refused and nothing here waits on a review. Both parameters are
    // still `deliveryBody`'s, and the merge queue fills them when it raises a card of its
    // own (lib/mergeadvocate.js) — which is the same card, from the one place that now
    // has an attempted merge to report.
    //
    // `asked` is deliberately narrower than `review` on its own: with auto-merge off for
    // this space every delivery is a question, so `--review` asked for nothing that was
    // not already going to happen, and a card claiming the worker chose this would be
    // crediting it with a decision it never had.
    asked: review && policy.autoMerge && !editHold,
    // Ahead of `asked` in the card's precedence, and it has to be: with the hold on, a
    // worker's `--review` asked for nothing that was not already going to happen, and a
    // card crediting it with the decision would be describing a choice it never had.
    edit: editHold,
    ship: shipHint,
  }),
  '--json',
]);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const questionId = created.id || created.issue?.id;

// The work bead waits behind the question. Without this the advocate's next tick sees
// a bead that is open and unblocked, and opens a second session onto work that is
// already sitting in a PR — the exact duplication the whole channel exists to stop.
// No `human` fallback here, unlike ask and propose: the work bead is about to be
// closed by the merge, and a label nothing takes back off would leave it in the
// inbox as a card with no question on it forever.
{
  const { parked, note } = park(bd, beadId, questionId, { label: false });
  if (!parked) console.error(`beadcause-deliver: ${note}`);
}

try {
  bd([
    'comment',
    beadId,
    `Delivered as [#${request.number}](${request.url}) on \`${branch}\`. Waiting on ${questionId} for the merge.` +
      (superseded.length
        ? ` It replaces ${superseded.join(', ')}, which asked the same question and ${superseded.length === 1 ? 'was' : 'were'} never answered.`
        : '') +
      (editHold ? ` It was not merged, and will not be by a worker: ${EDIT_HOLD}.` : '') +
      (owed ? ` Still owed after the merge: ${owed}.` : ''),
  ]);
} catch {
  /* The comment is a courtesy; the dependency above is the part that matters. */
}

// And on the pull request itself, because that is where whoever opens the diff is
// standing. A green PR sitting open for two days with nothing on it to say why is the
// state this whole fallback exists to avoid being mysterious about — and it is now
// *always* green-and-open when this runs, since nothing here attempts a merge to have
// failed at.
const prNote = editHold
  ? `A beadcause worker opened this and stopped on purpose: ${beadId} was typed into the running app with edit mode on, and an in-app edit is merged by the person who asked for it.`
  : review
    ? `A beadcause worker opened this and stopped on purpose: it asked for a human on this one rather than putting it on the merge queue.`
    : `A beadcause worker opened this and stopped: auto-merge is off for this space, so every delivery here is ${owner}'s call.`;
if (prNote) {
  await pr
    .comment(dir, request.number, `${prNote}\n\nIt is now ${owner}'s call — see ${questionId}.`)
    .catch((err) => console.error(`beadcause-deliver: could not comment on #${request.number} — ${first(err)}`));
}

console.log(`${questionId} ${request.url}`);
