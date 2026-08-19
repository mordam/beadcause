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
 * ## What the card may offer, which is not the same as what it may say
 *
 * The fact is the same on every bead; the *offer* is not. `bc-xl7n.52`: an advocate's
 * triage note named the branches its two children were sitting in, as evidence they were
 * alive — and because `branchNamesIn` reads the notes like every other field, and nothing
 * checks that a branch belongs to the bead the text was found in, the P0 that commissioned
 * the survey acquired two cards offering to close *itself*. It has seven open descendants.
 * The failure is correlated with the beads it is worst on: only a P0 gets an advocate, and
 * only an advocate writes long notes surveying other beads' branches, so the more thorough
 * the note the more close-offers its own root accrues.
 *
 * So **`close-it` is offered only where closing could not strand anything**: never on an
 * epic, never on a bead with a live descendant at any depth, and never where the shape of
 * the tracker could not be read. Everything else is unchanged — the fact still goes on the
 * thread, the card still says the branch is in, `keep-open` is still there. What goes is
 * the one tap. That is Adam's call, taken on 2026-08-17 over three narrower candidates
 * (match only branches the bead plausibly owns; drop `notes` from `FIELDS`; expire a stale
 * card), and it is the one that holds *whichever* of those is done later: a close offer on
 * a container root is wrong even when the branch really is that bead's.
 *
 * ## Whose branch this is, not only what the card may say about it (bc-xl7n.67)
 *
 * The card fix above stops the worst of it — an epic can no longer be offered its own
 * close on the strength of a child's branch — but it left the noisy half standing: an
 * advocate's triage note naming a dozen children's branches is still the densest possible
 * source of *other beads'* branch names, and every one of those still writes a card, a
 * comment and a `human` label onto the P0 the note lives on. `alreadyAsked` bounds it to
 * once per branch, not to zero.
 *
 * So the sweep no longer asks `branchNamesIn` for every match in every field; it asks
 * `ownedBranchNamesIn`, which keeps only the ones this bead *plausibly owns* — the same
 * tag test `ownsBranch` in lib/notinmain.js already uses to tell a bead's own worktree
 * from a sibling's for the mirror sweep. A branch belongs to a bead when it ends in that
 * bead's tag (`bc-xl7n.67` → `xl7n67`, so `worktree-anything-xl7n67`), in *any* field —
 * title, description or notes alike, because a bead naming its own branch in its own
 * notes (a delivering session recording where it landed) is still exactly the case this
 * exists for. What changes is only branches belonging to *someone else*, found in prose
 * about someone else's work.
 *
 * This is stricter than the tracker's own gate on purpose, in two ways. `Bd.gateFor`
 * refuses a close over an open **child**, so a bead whose children are all closed over an
 * open *grandchild* passes it; and bd has no opinion at all about an epic with nothing
 * under it yet, which is exactly the standing root a survey is about to fill. The gate is
 * also a refusal rather than an absence — it arrives as a 409 after the tap, and on the
 * open card it withdraws the answer button altogether (`freeformHtml` in public/app.js),
 * so a card whose only option cannot close anything is the one shape that stays answerable.
 *
 * Nothing here closes, reopens, merges, pushes or deletes anything, and every failure
 * is a sentence in the returned object rather than a throw — a sweep is a courtesy on
 * top of the advocate's tick and may not take the tick down with it.
 */
import { git, gitCode, ok, refTip, mainCheckout } from './gitref.js';
import { childrenFrom } from './ancestry.js';
import { UNENDORSED } from './endorse.js';
import { MERGE_LABEL } from './mergebead.js';
import { ownsBranch } from './notinmain.js';

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
 * Every branch this bead *plausibly owns*, out of everything `branchNamesIn` found.
 *
 * `branchNamesIn` is a plain scanner — it reads whatever text is there and does not ask
 * whose branch it found, which is right for a caller that wants every match and wrong
 * for a sweep about to ask a bead whether *its own* work has landed. `ownsBranch`
 * (lib/notinmain.js) is the same tag test the mirror sweep uses to tell a bead's own
 * worktree from a sibling's: a branch belongs to a bead when it ends in that bead's tag,
 * so `worktree-inmain-noclose-xl7n52` is `bc-xl7n.52`'s and is not `bc-xl7n`'s, however
 * many times the epic's own triage note names it.
 *
 * Deliberately field-blind, same as `branchNamesIn` underneath it: a bead naming its own
 * branch in its *notes* — a delivering session recording where it landed — is still
 * exactly the case this sweep exists for, so ownership is what narrows the match, not
 * which field it was found in.
 */
export function ownedBranchNamesIn(bead) {
  const id = String(bead?.id || '');
  return branchNamesIn(bead).filter((name) => ownsBranch(id, name));
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
 *
 * **A merge-bead is out, and it is the one exclusion here that protects something other
 * than the bead itself — bc-7qo.8.** The question this sweep asks is "the branch you name
 * has landed; are you finished?", and on a merge-bead that is meaningless twice over: its
 * lifetime is bounded by its pull request, so it finishes when the merge lands and never
 * before, and the branch it names is its *own*, which landing is the thing it exists to
 * do. What made this urgent is not the nonsense card but the label under it. Flagging a
 * bead applies `human`, and `human` is what `bd.listAgent` excludes — which is the merge
 * queue's only read of the tracker (lib/mergequeue.js). So one card here does not annoy
 * one bead, it takes that pull request out of the queue's sight for ever, in silence: an
 * empty sweep describes as the empty string and logs nothing at all. Measured 2026-08-16
 * on #346 and #342, both CLEAN, green and approved, one of them for twenty hours over
 * five approvals — and `admitPlan` could not undo it, because a bead that still carries
 * the label and the assignee reads to it as one the queue is already moving.
 *
 * Off `MERGE_LABEL` rather than off the `beadpr` block, deliberately: the label is what
 * every other part of the queue selects on (`isMergeBead`), and a bead whose block has
 * stopped parsing is exactly the one whose card would be most misleading.
 */
export function isCandidate(bead) {
  const status = String(bead?.status || '').toLowerCase();
  if (status === 'closed' || status === 'in_progress' || status === 'deferred') return false;
  const labels = (bead?.labels || []).map((l) => String(l).trim());
  if (labels.includes(HUMAN_LABEL) || labels.includes(UNENDORSED)) return false;
  if (labels.includes(MERGE_LABEL)) return false;
  return true;
}

/** bd's word for a bead that holds work under it rather than being work. */
const EPIC = 'epic';

/**
 * What is under what, read once for the whole sweep — `{ children, beads, known }`.
 *
 * Built from the `bd export` index `Bd.graph` already keeps (lib/ancestry.js), because
 * the list rows this sweep runs on carry no parent at all and `bd show` would be a spawn
 * per bead. The graph is cached per workspace for a minute and the advocate's tick reads
 * it twice already, so on the sweep's own interval this costs nothing.
 *
 * **`known` is the honest half.** `Bd.graph` never throws: a failed export comes back as
 * the last good answer, or as an empty index carrying `error`. Both are "I could not find
 * out what is under this bead", which is not "there is nothing under it" — and the whole
 * point of the caller is that the difference decides whether a one-tap close is offered.
 * So an empty index, or one that says it failed, answers `known: false` and the offer is
 * withheld: a card missing an option is an annoyance, and a card offering to close a P0
 * over seven open descendants is the bead this exists to prevent.
 */
export function familyOf(index) {
  const beads = index?.beads instanceof Map ? index.beads : new Map();
  return { children: childrenFrom(index?.parents), beads, known: beads.size > 0 && !index?.error };
}

/**
 * Everything under `id` that is not closed, at any depth — ids, in no particular order.
 *
 * Descendants rather than children, which is the one place this is deliberately stricter
 * than `Bd.gateFor`: that gate asks bd for the bead's *children*, so a bead whose children
 * are all closed over a live grandchild passes it and closes. The subtree is what leaves
 * the board, so the subtree is what is asked about.
 *
 * A row the index has never heard of counts as open. It cannot happen through `indexFrom`
 * — every child in the parent map came from a row in the same export — and if it ever
 * does, the safe reading of "I do not know what this is" is the one that withholds the
 * close. The seen-set is what bounds a cycle; bd cannot express one, and a walk that
 * hangs the advocate's tick over a tracker that somehow did is not worth the saving.
 */
export function liveUnder(family, id) {
  const root = String(id || '');
  const out = [];
  const seen = new Set([root]);
  const queue = [...(family?.children?.get(root) || [])];
  while (queue.length) {
    const at = String(queue.shift());
    if (seen.has(at)) continue;
    seen.add(at);
    const row = family?.beads?.get(at);
    if (String(row?.status || 'open').toLowerCase() !== 'closed') out.push(at);
    queue.push(...(family?.children?.get(at) || []));
  }
  return out;
}

/**
 * May this card offer to close the bead, and if not, what does it say instead?
 *
 * `{ close, why }`, where `why` is a clause for the card — it is read by whoever opens it
 * on a phone, so it names the beads rather than reporting a count and leaving them to be
 * hunted for.
 *
 * Three refusals, in the order they are cheapest to establish. **An epic never gets the
 * offer**, whatever is under it: an epic finishes when its theme does and not when a
 * branch sharing its name lands — the rule `bin/deliver.js` already keeps on the merge
 * side (`epicStaysOpen`) and `Bd.gateFor` keeps on a merge close reason — and a standing
 * root with nothing under it *yet* is exactly the bead a survey is about to fill. **A
 * tracker whose shape could not be read** gets the same answer, for `familyOf`'s reason.
 * And **a live descendant** takes it away, at any depth.
 *
 * The type is read off the row first and the index second. Both carry it; the row is what
 * the sweep already has in hand, and a bead that arrived from somewhere other than an
 * export — a test, a caller with its own rows — should not need the graph to be told it
 * is an epic.
 */
export function closeOffer(bead, family) {
  const id = String(bead?.id || '');
  const type = String(bead?.issue_type || bead?.type || family?.beads?.get(id)?.issue_type || '').toLowerCase();
  if (type === EPIC) {
    return { close: false, why: 'it is an epic, and an epic is finished when its theme is, not when a branch sharing its name lands' };
  }
  if (!family?.known) {
    return { close: false, why: 'the shape of this tracker could not be read on this pass, so what sits under this bead is unknown' };
  }
  const live = liveUnder(family, id);
  if (live.length) {
    const named = live.slice(0, 6).join(', ') + (live.length > 6 ? `, and ${live.length - 6} more` : '');
    return {
      close: false,
      why: `${live.length} bead${live.length === 1 ? '' : 's'} under it ${live.length === 1 ? 'is' : 'are'} still open — ${named}`,
    };
  }
  return { close: true, why: '' };
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

/**
 * The line on the thread. Short: the card carries the reasoning, this carries the fact.
 *
 * It says which of the two cards went up, because the thread is where somebody reading
 * the bead later finds out what was done to it — and "asked whether this bead goes with
 * it" over a card that offered no such thing would be the comment describing the card the
 * sweep did not write.
 */
export const inMainComment = (branch, baseName, { close = false, why = '' } = {}) =>
  `\`${branch}\` is already in \`${baseName}\`. ${
    close ? 'Asking whether this bead goes with it' : `Saying so on a card that offers no close — ${why}`
  } — see the card in the inbox. Nothing has been closed.`;

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
 *
 * **`close` decides whether there are two options or one** — `closeOffer` above is what
 * decides `close`, and the header says why. The default is the offer *withheld*, which is
 * the wrong way round for convenience and the right way round for a mistake: a caller that
 * forgets to say gets the card that cannot strand anything.
 *
 * The one option left is a commission, and that is what keeps the card answerable rather
 * than merely harmless. bd refuses a close over an open child and the phone withdraws the
 * whole answer button when it knows the refusal is coming (`freeformHtml` in
 * public/app.js) — so on precisely the beads this withholds the offer from, a card
 * carrying `close-it` is a dead end: no button, no answer, and the `human` label sitting on
 * the bead until somebody closes the children. A card whose every option is `closes: false`
 * cannot be refused: `/api/respond` skips the gate for a commission, and a *typed* answer
 * on a card where any option would have commissioned rides the same path (`ambiguous` in
 * lib/server.js). It hands the bead back to `bd ready` with the finding on it, which is
 * the whole of what this sweep was ever entitled to do here.
 */
export function inMainAsk(id, branch, landing, baseName, { close = false, why = '' } = {}) {
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
${
  close
    ? ''
    : `
**There is no "close it" on this card, and that is on purpose** — ${why}. Where a bead
holds a subtree, closing it takes the subtree with it, and where that bead is the P0 the
subtree hangs from, every one of them leaves the board altogether: a bead with no P0 above
it is not dispatched. That is a great deal to do with one thumb on the strength of a branch
name found in some prose, and prose is where this one was found. So the card states the
fact and stops. If it really is finished, close it from the bead itself, where what is
under it is in front of you.
`
}
"Keep it open" hands it straight back to \`bd ready\` as ordinary work, with this note
still on it. It is the right answer whenever the branch was a step rather than the job.

\`\`\`decision
question: "\`${branch}\` is already in ${baseName} — ${close ? `is ${id} finished?` : `${id} is not closed on the strength of that. Hand it back to the queue?`}"
options:${
    close
      ? `
  - id: close-it
    label: Close it — the work is in main
    response: "Closed: \`${branch}\` is already in ${baseName}${sha ? ` as \`${sha}\`` : ''}, so this bead's work has landed."
    hint: ${sha ? `Landed as ${sha}` : 'Already an ancestor of the base'}`
      : ''
  }
  - id: keep-open
    label: ${close ? 'Keep it open — more is owed' : 'Keep it open — the branch landed, the bead has not'}
    response: "Kept open: \`${branch}\` is in ${baseName}${close ? ', but this bead wants more than what landed' : '; a landed branch is not enough to close this one, so it goes back to the queue with the finding on it'}."
    hint: Back to \`bd ready\` as ordinary work
    closes: false
\`\`\`
`;
}

/**
 * Sweep one workspace against one checkout. Returns what it flagged and what it did not.
 *
 * `rows` exists for the tests and for a caller that has already read the tracker this
 * tick; everything else pays for one `bd list`. `index` is the same courtesy for the
 * `bd export` shape — see `familyOf` — and a caller that passes neither pays for the
 * cached read, which the advocate's tick has usually already warmed.
 */
export async function sweepInMain(bd, ws, dir, { base = 'main', rows = null, index = null } = {}) {
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

  /**
   * What is under each bead, once for the whole sweep and before any of it.
   *
   * Not per bead, and not lazily: `childrenFrom` inverts the parent map, which is one
   * pass over the workspace, and doing it inside the loop would rebuild the same index
   * for every bead that happens to name a branch. `Bd.graph` itself is cached and shared
   * with the rest of the tick, so the read behind this is usually already paid for.
   *
   * A `bd` that has no `graph` at all — a caller's own stub — is `known: false` rather
   * than a throw, and `closeOffer` turns that into a card with no close on it. That is
   * the direction a missing answer has to fail in here.
   */
  let shape = index;
  if (!shape) {
    try {
      shape = await bd.graph?.(ws);
    } catch {
      shape = null;
    }
  }
  const family = familyOf(shape);

  out.ok = true;

  for (const bead of beads || []) {
    if (!isCandidate(bead)) continue;
    const branches = ownedBranchNamesIn(bead);
    if (!branches.length) continue;
    out.checked += 1;

    // Once per bead rather than once per branch: it is a fact about the bead, and a bead
    // naming two branches must not be told two different things about its own subtree.
    const offer = closeOffer(bead, family);

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
        await bd.comment(ws, bead.id, inMainComment(branch, baseRef.name, offer));
      } catch {
        /* the ask below is the part that matters */
      }

      try {
        // The ask, then the label, and in that order: the notes are where the card's
        // body and its `decision` block are read from (lib/decision.js), and the label
        // *is* "it is in the inbox". A card that appeared before its options were
        // written would be a question with no answers on it.
        await bd.appendNotes(ws, bead.id, inMainAsk(bead.id, branch, landing, baseRef.name, offer));
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
        // Whether the card offers the close, and why not where it does not — the advocate
        // logs it, because "asked whether it is finished" and "told it, and offered
        // nothing to press" are different things to have done to somebody's P0.
        close: offer.close,
        why: offer.why,
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
