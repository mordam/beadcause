/**
 * The bead whose branch is already in `main`, and nobody noticed.
 *
 * bc-u5f asked for `worktree-sessions-accordion-log-5f7` to be landed. It had been:
 * the branch came into main inside the `land-six-branches-q8v` batch, which landed six
 * branches under one bead and closed only its own. So bc-u5f stayed open, stayed in
 * `bd ready`, kept bc-h2s blocked behind it, and was eventually handed to an unattended
 * session that spent its whole turn proving the work was already there.
 *
 * lib/landed.js is the close relative and covers a different half of the same problem:
 * a *pull request* that merged on github.com. It closes, because a merged PR names its
 * bead and GitHub's `MERGED` is proof. This one cannot close anything and must not try,
 * because the evidence is weaker in exactly one way that matters: a bead can name a
 * branch that landed and still want something more than what landed. "The branch is in"
 * is a fact; "so the bead is done" is a judgement, and it is Adam's.
 *
 * So this proposes, in lib/superseded.js's shape, because it is the same shape: a fact a
 * sweep can establish, a decision that stays with Adam, and no session spent on it. One
 * line on the thread, an ask with a `decision` block appended to the bead's notes so the
 * judgement is one tap from a phone, and the `human` label — which is also the whole of
 * the saving, because `bd ready` excludes `human` and an advocate that cannot see a bead
 * cannot open a session on it. **The card is the bead itself**, not a separate question
 * about it: answering a `human` bead closes it (`respond` in lib/bd.js), so one tap is
 * the close, with nothing to keep in step. The other option does not close — it is a
 * commission, so "keep it open" drops the label and hands the bead back to `bd ready`
 * unclosed, with the finding on it.
 *
 * ## What counts as "already in main"
 *
 * `git merge-base --is-ancestor <branch> main` is the question the bead asked for, and
 * on its own it answers yes for a case that is not a merge at all: **a worktree branch
 * nobody has committed on yet.** A fresh worktree branches from main, so its tip *is* a
 * main commit, so it is an ancestor of main, and a bead filed by a session mid-task
 * would be flagged as finished before it had written a line. That is the one way this
 * could do real harm, so ancestry is necessary here and not sufficient:
 *
 *   1. The tip is an ancestor of the base — otherwise there is nothing to discuss.
 *   2. Some **merge** between the tip and the base holds the tip as a *later* parent.
 *
 * Rule 2 is the discriminator, and it is worth stating in one line: a second parent is
 * the only trace git keeps of "main took this in". Merging a branch into main writes a
 * commit whose first parent is main and whose second is the branch. An unstarted
 * worktree's tip is a commit on main's own line of development, so every merge past it
 * holds it as a *first* parent — main carrying on rather than main taking something in.
 * The two are identical to `--is-ancestor` and are never confused by this.
 *
 * The oldest qualifying merge is the answer, not the newest and not simply the oldest
 * commit on the path: a branch can be merged once and have descendants merged later, and
 * what landed it is the first time main took it.
 *
 * It is the ancestry walk `mergeCommitFor` does in lib/sessionlog.js, one question
 * further on, and not a call to it: that one hardcodes `main` as both the base and the
 * remote-agnostic spelling of it, and it reads the last commit on the path without
 * asking whose parent the tip is — which is right for its own caller, which only ever
 * asks about a session that produced commits, and wrong here.
 *
 * ## What it deliberately does not catch
 *
 * **A squash merge.** The squash commit carries the branch's tree and none of its
 * history, so `--is-ancestor` is false forever and this says nothing at all. That is
 * the right failure: saying nothing costs one session, and the alternative — comparing
 * trees or patch-ids to guess — is how a sweep ends up re-flagging the same bead every
 * interval because its evidence flickers. lib/landed.js already reads squash merges out
 * of GitHub, where the answer is recorded rather than inferred.
 *
 * **A fast-forward.** Then the tip *is* the base tip, there is no landing commit to
 * read, and an unstarted worktree cut from the current main looks exactly the same.
 * Skipped with a reason rather than guessed.
 *
 * **A branch whose ref is gone.** Nothing to ask git about. beadcause's own attic keeps
 * branches when it retires a worktree (lib/attic.js), so this is rare, and a pruned
 * branch is reported rather than silently dropped.
 *
 * Nothing here closes, reopens, merges, pushes or deletes anything, and every failure
 * is a sentence in the returned object rather than a throw — a sweep is a courtesy on
 * top of the advocate's tick and may not take the tick down with it.
 */
import { git, gitCode, ok, refTip, mainCheckout } from './gitref.js';
import { UNENDORSED } from './endorse.js';

/** The label that puts a bead in the inbox and takes it out of every advocate queue. */
const HUMAN_LABEL = 'human';

/**
 * A worktree branch as this laptop names them: `worktree-<slug>-<tag>`.
 *
 * Deliberately narrow. The alternative — any word that could be a branch — would ask
 * git about every noun in every description, and a bead that happened to name a real
 * ref would be flagged on the strength of a coincidence. Every branch this convention
 * produces starts `worktree-`, and a bead that means one writes it out in full.
 *
 * Ends on an alphanumeric so the trailing punctuation of an English sentence — a full
 * stop, a comma, a closing backtick — is not read as part of the ref name.
 */
const BRANCH_RE = /\bworktree-[a-z0-9][a-z0-9._-]*[a-z0-9]\b/gi;

/**
 * The fields of a bead that may name a branch.
 *
 * `acceptance_criteria` and `acceptance` are the same field under the two names it
 * arrives with — the first from `bd list --json`, the second from the shapes elsewhere
 * in this codebase build. `design` is in neither list row and is in `bd show`, and is
 * here for the same reason: this reads whatever it is handed rather than requiring the
 * caller to have fetched a particular one.
 */
const FIELDS = ['title', 'description', 'design', 'notes', 'acceptance', 'acceptance_criteria'];

/**
 * Every worktree branch this bead names, once each, in the order they appear.
 *
 * A bead naming two branches is ordinary — "land A, which B was cut from" — and both
 * are asked about, because the interesting one is whichever landed.
 */
export function branchNamesIn(bead) {
  const seen = new Set();
  for (const field of FIELDS) {
    const text = String(bead?.[field] || '');
    if (!text) continue;
    for (const m of text.matchAll(BRANCH_RE)) {
      const name = m[0];
      // Refs are case-sensitive, so the name is kept exactly as written; the cap is
      // there because a ref is a filename and something 200 characters long is prose
      // that happened to match, not a branch.
      if (name.length <= 80) seen.add(name);
    }
  }
  return [...seen];
}

/**
 * Is this bead one to look at?
 *
 * `in_progress` is the exclusion worth explaining: a session is sitting in that bead
 * right now, and the branch it names is most likely its own, mid-flight. Flagging it
 * would put a card in the inbox proposing to close work that is being done while it is
 * being done — and the case this exists for happens *before* a session opens, not
 * during one. A held bead is out for a simpler reason: nothing may open a session on it
 * at all (lib/endorse.js), so there is no session to save and the card would be noise.
 */
export function isCandidate(bead) {
  const status = String(bead?.status || '').toLowerCase();
  if (status === 'closed' || status === 'in_progress' || status === 'deferred') return false;
  const labels = (bead?.labels || []).map((l) => String(l).trim());
  if (labels.includes(HUMAN_LABEL) || labels.includes(UNENDORSED)) return false;
  return true;
}

/**
 * The base to measure against: `origin/main` if this checkout has it, else `main`.
 *
 * Remote first, and for the reason lib/landed.js gives as its first rule. Local `main`
 * on this Mac routinely carries merges nobody has pushed — a dozen sessions land on it
 * through GitHub and pull at their own pace — and "it is in main" is a claim about what
 * everybody has, not about what this laptop happens to have fetched. The ref that was
 * used is reported, because a sweep run against local `main` is making a weaker claim
 * and the comment it writes should say which.
 */
async function pickBase(dir, base) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const sha = await refTip(dir, ref);
    if (sha) return { ref, name: ref.startsWith('refs/remotes/') ? `origin/${base}` : base };
  }
  return null;
}

/**
 * The branch's tip, local ref or origin's, or null if neither exists.
 *
 * Fully qualified on purpose: `rev-parse worktree-x` will happily resolve a *file*
 * called `worktree-x` in the working directory, and a bare name that matches both a
 * local and a remote branch is an ambiguity git resolves with a warning nobody reads.
 */
async function tipOf(dir, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const sha = await refTip(dir, ref);
    if (sha) return { sha, ref };
  }
  return null;
}

/**
 * The commit that brought `tip` into `baseRef`, or why it did not.
 *
 * `{ landed: true, commit, subject }` on the one case that counts — see rule 2 in the
 * header. Everything else is `{ landed: false, why }`, and `why` is written to be read
 * in a log line: a sweep that flags nothing should still be able to say what it looked
 * at and what it decided.
 */
export async function landingMerge(dir, tip, baseRef) {
  const ancestry = await gitCode(dir, ['merge-base', '--is-ancestor', tip, baseRef]);
  // 1 is git's word for "no", which is the ordinary answer: an unmerged branch, or one
  // that was squash-merged and never will be an ancestor. Anything else is git being
  // unable to answer, and that is not a "no" — it must not read as one.
  if (ancestry.code === 1) return { landed: false, why: 'not an ancestor of the base' };
  if (ancestry.code !== 0) {
    return { landed: false, unknown: true, why: `git could not compare it — ${ancestry.stderr.split('\n')[0] || `exit ${ancestry.code}`}` };
  }

  // Every *merge* between the tip and the base, each with its parents on the same line.
  // `--merges` is not an optimisation so much as the question restated: only a merge can
  // have a second parent, and a second parent is the entire evidence being looked for.
  const walk = await ok(git(dir, ['rev-list', '--merges', '--parents', '--ancestry-path', `${tip}..${baseRef}`]));
  const lines = String(walk || '')
    .trim()
    .split('\n')
    .filter(Boolean);

  // Newest first, so the oldest such merge is the last line — and the oldest merge that
  // took this tip in is the one that landed it, whatever happened to the branch after.
  let landing = '';
  for (const line of lines) {
    const [sha, ...parents] = line.split(/\s+/).filter(Boolean);
    if (parents.slice(1).includes(tip)) landing = sha;
  }

  if (!landing) {
    /**
     * No merge on the way to the base has this tip as a later parent — so whatever
     * ancestry said, nothing took this branch *in*. Both of the cases named in the
     * header land here, and they are the same case seen from two angles:
     *
     *   - **An unstarted worktree.** Its tip is a commit on the base's own line of
     *     development, so every merge past it holds it as a *first* parent — main
     *     carrying on, not main taking something in.
     *   - **A fast-forward**, including a tip sitting exactly on the base tip, where
     *     there is no merge commit to find and never was.
     *
     * One message, because the difference between them is not one this can see and not
     * one a log line should pretend to.
     */
    return {
      landed: false,
      why: 'nothing merged it in — the tip is a commit on the base’s own history, which is also what an unstarted worktree branch looks like',
    };
  }

  const subject = String((await ok(git(dir, ['log', '-1', '--format=%s', landing]))) || '').trim();
  return { landed: true, commit: landing, subject };
}

/**
 * Where the sweep leaves its fingerprint, so it can tell its own work from a rewrite —
 * lib/superseded.js's `ASK_MARK`, keyed by branch.
 *
 * **Keyed by branch, and that is the whole of the idempotence.** A bead naming two
 * branches gets one card per branch, as the second one lands; a bead already asked about
 * a branch is never asked about it again.
 *
 * It lives in the notes rather than in a comment because the notes travel on the list
 * row this sweep already has, so the guard costs no call — and because the *label* is the
 * one thing an answer takes back off. "Keep it open" is a commission (lib/bd.js): it
 * drops `human` and returns the bead to `bd ready`, still naming the same branch, still
 * in main. A guard that read the label would re-flag it on the next interval, and the
 * one after that, forever. That is the loop this must not have.
 */
export const askMark = (branch) => `<!-- beadcause:inmain ${branch} -->`;

/**
 * Has this bead already been asked about this branch? Read off the row `bd list` returned.
 *
 * Every field, not just the notes, because a bead is somebody's to edit: an ask moved
 * into the description by hand is still an ask, and asking again over the top of it
 * would be the sweep arguing with a human.
 */
export const alreadyAsked = (bead, branch) =>
  FIELDS.some((f) => String(bead?.[f] || '').includes(askMark(branch)));

/** The line on the thread. Short: the card carries the reasoning, this carries the fact. */
export const inMainComment = (branch, baseName) =>
  `\`${branch}\` is already in \`${baseName}\`. Asking whether this bead goes with it — see the card in the inbox. Nothing has been closed.`;

/**
 * The card: markdown with a `decision` block in it, appended to the notes.
 *
 * **No option is recommended, and that is deliberate.** lib/superseded.js stars its close
 * and has earned it — a worker looked at two beads and said they were the same job, so
 * the card is carrying somebody's judgement. This one is carrying a fact about git, and
 * the fact says nothing whatever about whether the *bead* is finished. A star here would
 * be the card recommending an answer in the same breath as admitting it cannot tell.
 *
 * Nothing interpolated into the block comes from prose. The branch name is what
 * `BRANCH_RE` matched, so it is `[A-Za-z0-9._-]` and nothing else; the sha is hex; the id
 * is a bead id. The landing commit's *subject* is arbitrary text somebody wrote, and it
 * stays out of the YAML entirely — it belongs in the markdown above, where a stray quote
 * is a stray quote rather than a block that will not parse.
 *
 * Every value that begins with the branch name is **double-quoted**, and that is not
 * housekeeping: a backtick is a reserved indicator at the start of a YAML plain scalar,
 * so `question: \`worktree-x\` …` is a parse error rather than a string. It fails in the
 * one place nothing else would notice — lib/decision.js reports it and the card falls
 * back to a free-text box, which reads exactly like a card nobody wrote options for.
 * test/inmain.mjs reads the block back through `toQuestion` for that reason.
 */
export function inMainAsk(id, branch, landing, baseName) {
  const sha = String(landing.commit || '').slice(0, 8);
  // Stripped of the three characters that would end a fence, start emphasis, or open a
  // code span in the middle of somebody else's sentence.
  const subject = landing.subject ? landing.subject.replace(/[*_`]/g, '') : '';
  return `${askMark(branch)}
## \`${branch}\` is already in \`${baseName}\`

The branch this bead names came into \`${baseName}\` as \`${sha}\`${subject ? ` — *${subject}*` : ''}, so
whatever was on it has landed. Nothing about that closed this bead, because the two are
not the same claim: a bead can name a branch that landed and still want more than what
landed, and only you can say which this one is.

**Nothing has been closed and nothing will be.** The sweep that found this cannot close a
bead — see lib/inmain.js. What it can do is stop a session being opened on work that is
already in ${baseName}, which is what the \`human\` label on this bead is now doing, and ask.

"Keep it open" hands it straight back to \`bd ready\` as ordinary work, with this note
still on it. It is the right answer whenever the branch was a step rather than the job.

\`\`\`decision
question: "\`${branch}\` is already in ${baseName} — is ${id} finished?"
options:
  - id: close-it
    label: Close it — the work is in main
    response: "Closed: \`${branch}\` is already in ${baseName}${sha ? ` as \`${sha}\`` : ''}, so this bead's work has landed."
    hint: ${sha ? `Landed as ${sha}` : 'Already an ancestor of the base'}
  - id: keep-open
    label: Keep it open — more is owed
    response: "Kept open: \`${branch}\` is in ${baseName}, but this bead wants more than what landed."
    hint: Back to \`bd ready\` as ordinary work
    closes: false
\`\`\`
`;
}

/**
 * Sweep one workspace against one checkout. Returns what it flagged and what it did not.
 *
 * `rows` exists for the tests and for a caller that has already read the tracker this
 * tick; everything else pays for one `bd list`.
 */
export async function sweepInMain(bd, ws, dir, { base = 'main', rows = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [] };

  let main;
  try {
    main = await mainCheckout(dir);
  } catch (err) {
    // The ordinary cause is a workspace with no code behind it — a scratch tracker
    // under ~/beads, where `resolveSessionDir` answers with the workspace's own home.
    // Not an error, and not worth a line every interval.
    out.reason = `${dir} is not a git checkout — ${String(err.message || err).split('\n')[0]}`;
    return out;
  }

  const baseRef = await pickBase(main, base);
  if (!baseRef) {
    out.reason = `neither origin/${base} nor ${base} is a ref in ${main}`;
    return out;
  }

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.listAgent(ws);
    } catch (err) {
      out.reason = `bd list failed — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  out.ok = true;

  for (const bead of beads || []) {
    if (!isCandidate(bead)) continue;
    const branches = branchNamesIn(bead);
    if (!branches.length) continue;
    out.checked += 1;

    for (const branch of branches) {
      // Asked before git is, because it is a string comparison against a row already in
      // hand and the git walk below is four processes. A bead that has been asked about
      // is the common case on every sweep after the first.
      if (alreadyAsked(bead, branch)) {
        out.skipped.push({ id: bead.id, branch, why: 'it already carries the ask about this branch', quiet: true });
        continue;
      }

      const tip = await tipOf(main, branch);
      if (!tip) {
        out.skipped.push({ id: bead.id, branch, why: 'no local or origin ref by that name' });
        continue;
      }

      const landing = await landingMerge(main, tip.sha, baseRef.ref);
      if (!landing.landed) {
        // `quiet` on everything except git being unable to answer: "not merged yet" is
        // the ordinary state of most branches most of the time, and a log line per
        // unmerged branch per interval would bury the one that matters.
        out.skipped.push({ id: bead.id, branch, why: landing.why, quiet: !landing.unknown });
        continue;
      }

      // The comment first, so whatever fails after it the fact is on the thread — the
      // discipline `respond` keeps in lib/bd.js, and the one lib/superseded.js keeps
      // here. A tracker that took this and not the card should still ask: a missing
      // comment costs a sentence, and a missing card costs a bead nobody is ever asked
      // about, on work already in main.
      try {
        await bd.comment(ws, bead.id, inMainComment(branch, baseRef.name));
      } catch {
        /* the ask below is the part that matters */
      }

      try {
        // The ask, then the label, and in that order: the notes are where the card's
        // body and its `decision` block are read from (lib/decision.js), and the label
        // *is* "it is in the inbox". A card that appeared before its options were
        // written would be a question with no answers on it.
        await bd.appendNotes(ws, bead.id, inMainAsk(bead.id, branch, landing, baseRef.name));
        await bd.addLabel(ws, bead.id, HUMAN_LABEL);
      } catch (err) {
        out.skipped.push({ id: bead.id, branch, why: `could not put it in the inbox — ${String(err.message || err).split('\n')[0]}` });
        continue;
      }

      out.flagged.push({
        id: bead.id,
        title: bead.title || '',
        branch,
        commit: landing.commit,
        subject: landing.subject || '',
        base: baseRef.name,
      });
    }
  }

  return out;
}

/** One line for the log and the card. Empty when the sweep found nothing worth saying. */
export function describeInMain(result) {
  if (!result.ok) return result.reason ? `in-main sweep skipped — ${result.reason}` : '';
  if (!result.flagged.length) return '';
  const named = result.flagged.map((f) => `${f.id} (${f.branch})`).join(', ');
  return `flagged ${result.flagged.length} bead${result.flagged.length === 1 ? '' : 's'} whose branch is already in main — ${named}`;
}
