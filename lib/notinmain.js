/**
 * The bead that is **closed** over a branch that never reached `main`.
 *
 * lib/inmain.js sweeps one direction of this and it is the safer one: an *open* bead
 * whose branch is already in `main`, so nobody spends a session re-doing landed work.
 * The cost of missing one of those is a wasted window. This is the other direction, and
 * the cost of missing one of these is the work itself.
 *
 * bc-nib3.5 is the worked example. Its session built `/bead-session`, ran the whole
 * suite green, and then closed the bead by hand with a close reason ending "On
 * worktree-bead-session-nib35, not merged". The branch was never pushed and no pull
 * request was ever opened. From every surface in the app that bead reads as finished:
 * closed, with a close reason that looks exactly like a delivery summary — **a closed
 * bead with a detailed close reason is the least suspicious thing in the tracker.** Two
 * things then compounded: `bd ready` handed out the child that links *to* that page, so
 * an unattended session was opened against a page that does not exist on main; and
 * lib/tidy.js retires the worktree, after which the only trace is a local branch nobody
 * is looking at. bc-5lcc and bc-0nq8 are two more, found the same way — by a later
 * session going to reuse something that was not there.
 *
 * So: ask git which of these branches never landed, and put the finding in front of
 * Adam. What it may do about it is deliberately almost nothing.
 *
 * ## What counts as this bead's branch
 *
 * **Only the branch this bead owns**, which is the branch whose trailing tag is the
 * bead's own id: `worktree-squash-proof-5lcc` for bc-5lcc, `worktree-bead-session-nib35`
 * for bc-nib3.5 (the punctuation comes out of the tag). Every worktree on this laptop is
 * named that way — see the worktree rules — and it is the second of the two passes the
 * `did-it-land` sweeps have always needed.
 *
 * Deliberately **not** the branches a bead *names in its prose*, which is what
 * lib/inmain.js matches on. The two sweeps are asking different questions and the
 * evidence is not interchangeable. "Is the branch this bead asked for already in?" is
 * answered by any branch the bead names. "Was this bead closed over work that never
 * landed?" is a claim about *its own delivery*, and a branch mentioned in passing cannot
 * support it: bc-5lcc's description names `worktree-config-secret-guard-m6m`, which
 * belongs to bc-m6m, and a sweep matching on prose would have accused bc-5lcc of being
 * closed over somebody else's unlanded branch. That branch has a bead of its own and
 * this sweep will reach it on its own row.
 *
 * ## What has to be true before anything is said
 *
 * Four facts, and each of them removes a way of being wrong:
 *
 *   1. **The branch exists**, locally or on origin. A branch that has been pruned is not
 *      evidence of anything and there is nothing left to land.
 *   2. **It has commits the base does not** — `rev-list --count base..tip`, and that one
 *      number is doing two jobs. A branch with nothing ahead of the base is either one
 *      git took in, or a worktree branched from `main` and never committed on, and this
 *      sweep is silent about both: the first has landed and the second is an empty room,
 *      of which there are dozens on this laptop at any moment.
 *
 *      Which is why there is no ancestry walk here, and lib/inmain.js has an elaborate
 *      one. That sweep has to tell those same two cases *apart* — both are ancestors of
 *      `main`, and only one of them means the work landed — so it goes looking for a
 *      merge holding the tip as a *later* parent. This one never has to: a branch with
 *      nothing of its own is not stranded work whichever of the two it is, so the count
 *      answers the whole question and a walk would be a second way of deciding the same
 *      thing, free to disagree with the first.
 *   3. **GitHub has no pull request for it.** This is the one that costs a network call
 *      and it is not optional. A squash merge leaves no ancestry at all — the squash
 *      commit carries the branch's tree and none of its history — so git alone would
 *      report every deliberate squash as lost work, forever, and a sweep that cries wolf
 *      is one nobody reads. GitHub is where a squash is *recorded* rather than inferred,
 *      which is the same division lib/inmain.js and lib/landed.js already make. An open
 *      pull request is not a merge but it is not stranded work either: somebody is
 *      already looking at it.
 *   4. **Its newest commit has been sitting there a while** — `GRACE_MS`, and the one
 *      bc-xl7n.63 added. Fact 3 is a reading taken at an instant, and a delivery pushes
 *      its branch some minutes before it opens its pull request: a sweep landing in that
 *      gap sees a branch on origin GitHub has no pull request for, which is exactly what
 *      stranded work looks like and is not it. Measured, on a card filed eight minutes
 *      before the pull request it says does not exist.
 *
 * ## And the reading has an age
 *
 * The card outlives the reading by days, so two things follow from that alone: it says
 * *when* GitHub was asked, and `followNotInMain` asks again on every sweep and closes the
 * card when the answer has changed. Fact 4 stops the common case being carded at all;
 * the follow-up catches the delivery that took longer than the grace, and is what keeps
 * this sweep and lib/sweepcard.js from holding two open cards asking incompatible things
 * about one branch.
 *
 * ## What it does about it
 *
 * **It does not close, reopen, merge, push or delete anything**, and it especially does
 * not reopen the bead. Reopening would put it straight back in `bd ready`, where the
 * advocate would open a session on work Adam has not been told about and may not want —
 * and "the branch never landed" is a fact a sweep can establish while "so land it" is a
 * judgement that stays with him.
 *
 * The card is therefore **a new bead**, and that is the one structural difference from
 * lib/inmain.js and lib/superseded.js, which both put the `decision` block on the bead
 * they are about. It cannot be done that way here, because the bead this is about is
 * closed and `bd human list` returns open issues only (`Bd.listHuman`): a card appended
 * to a closed bead would be a question nothing ever renders. So the finding gets a bead
 * of its own, carrying the branch, the commits, and the id of the bead it is about.
 *
 * That bead is also **the work item**, which is why its "land it" option is a commission
 * (`closes: false`, lib/decision.js). Answering it that way drops the `human` label and
 * hands the bead to `bd ready` as ordinary work, with everything a session needs already
 * written on it. The other option closes it and the closed bead stays closed. One tap
 * either way, and no window is opened on any of it until there has been a tap.
 *
 * ## The order of the writes, which is not the family's usual one
 *
 * lib/superseded.js and lib/inmain.js write the comment first, because there the card is
 * the bead and a comment that survives a failed second write still leaves the fact on
 * the thread. Here the card is a *separate* bead and is the only durable record, so it
 * is created first; then the fingerprint on the closed bead that stops this being asked
 * again; then the comment, which is a courtesy. A creation that fails has written
 * nothing at all and simply comes back next interval. A fingerprint that fails costs a
 * second card next interval — visible, dismissible, and much the better failure than a
 * fingerprint written over a card that was never filed, which would be a finding lost in
 * silence.
 *
 * Every failure is a sentence in the returned object rather than a throw: a sweep is a
 * courtesy on top of the advocate's tick and may not take the tick down with it.
 */
import { git, ok, refTip, mainCheckout } from './gitref.js';
import { UNENDORSED } from './endorse.js';
import { withDiscoveredFrom } from './filing.js';
import { homeIn } from './homing.js';
import * as pr from './pr.js';

/** The label that puts a bead in the inbox and takes it out of every advocate queue. */
const HUMAN_LABEL = 'human';

/**
 * How far back a closed bead is worth asking about.
 *
 * The same fortnight lib/landed.js uses, for a related reason: a bead closed a month ago
 * over a branch nobody has missed since is not news, and the question this raises — "is
 * this worth landing?" — gets a worse answer the further the branch is from the `main`
 * it would have to be rebuilt against. It also bounds the first run of the sweep on a
 * tracker with five hundred closed beads in it.
 */
export const RECENT_DAYS = 14;

/**
 * How many branches may be asked about GitHub in one sweep.
 *
 * The three git checks are local and cost milliseconds; the fourth is `gh pr list` and
 * costs a second or two, and it is only reached by a branch that git has already said is
 * not in `main`. This laptop keeps every retired worktree's branch (lib/attic.js), so
 * the first sweep after this ships has a decade of abandoned branches to work through
 * and the tick it is riding on has a queue to get to.
 *
 * Nothing is dropped by the cap — a branch not looked at writes no fingerprint, so it is
 * first in line next interval — but the count is reported, because a sweep that quietly
 * stops half way is indistinguishable from one that found nothing.
 */
export const MAX_ASKS = 20;

/**
 * How long a branch's newest commit has to have been sitting there before this is
 * willing to say nobody landed it — fact 4, and the one added by bc-xl7n.63.
 *
 * **The measured failure.** On 2026-08-14 this sweep filed a card at 15:40:21Z asserting
 * of `worktree-reenter-gate-f31f` that *"GitHub has no pull request for it — not merged,
 * not open, not refused."* Pull request #315 for that exact branch was opened at
 * 15:48:35Z, eight minutes later. Nothing was wrong with the reading; the reading was
 * taken inside the window between a session pushing its branch and the same session
 * opening its pull request, which is not a rare accident but *the ordinary shape of a
 * delivery* — bin/deliver.js pushes, then calls `gh pr create`, and anything between
 * those two lines sees a branch on origin that GitHub has no pull request for.
 *
 * The sweep runs on an hourly tick, so it lands in that window whenever a delivery is in
 * flight, which on this laptop is most evenings. Every one of those is a card in Adam's
 * inbox asking whether to land work that is already in review.
 *
 * So a branch whose newest commit is younger than this is **held, not dropped**: no
 * fingerprint is written, exactly as for a branch over `MAX_ASKS`, so it is looked at
 * again on the next sweep and carded then if it is still stranded. Two hours because a
 * delivery here is a commit, a full gate that regularly runs forty minutes, and then the
 * push and the pull request — and because the cost of the delay is nil. Every bead this
 * sweep is about was closed over work its own session already finished; a genuinely
 * abandoned branch has a tip weeks old and does not notice a two-hour hold, and one
 * closed inside the fortnight `RECENT_DAYS` allows is not more findable for being carded
 * an hour sooner.
 *
 * It is a guess about how long a session takes to open its pull request, which is why it
 * is not the whole fix: `followNotInMain` re-asks about the cards that were filed, and
 * catches the delivery that took longer than this.
 */
export const GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * The tag a worktree branch carries for a bead: the id with everything but letters and
 * digits taken out.
 *
 * `bc-nib3.5` is `worktree-bead-session-nib35` and `bc-rk2o.1` is
 * `worktree-poll-stream-rk2o1`, because a ref cannot hold every character a bead id can
 * and the tag is what survives. The workspace prefix goes too: every branch on this
 * laptop would carry the same one, so it distinguishes nothing and no worktree name has
 * ever included it.
 */
export function tagOf(id) {
  const suffix = String(id || '').split('-').slice(1).join('-');
  return suffix.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Does this branch belong to this bead?
 *
 * Anchored at both ends — `worktree-…-<tag>` and nothing after it — and the leading dash
 * is what makes it safe: `worktree-x-cab` is bc-cab's and is not bc-ab's, which a bare
 * "ends with the tag" test would have handed to both. An epic and its child still
 * collide in the other direction (bc-nib3's tag is a prefix of bc-nib3.5's, not a
 * suffix), which costs nothing here: each of them owns the branch that ends in its own
 * tag and neither owns the other's.
 */
export const ownsBranch = (id, branch) => {
  const tag = tagOf(id);
  return tag ? String(branch || '').toLowerCase().endsWith(`-${tag}`) : false;
};

/**
 * Every `worktree-…` branch this checkout knows about, local or on origin, once each.
 *
 * One `for-each-ref` per sweep rather than a `rev-parse` per bead: the branches are a few
 * hundred and the closed beads are a few hundred, and only one of those two numbers has
 * to be asked about at all. Origin's copies are folded onto the same name, since a
 * branch that exists in both places is one branch — `tipOf` below decides which ref to
 * measure, and it prefers the local one for the same reason lib/inmain.js does.
 */
export async function worktreeBranches(dir) {
  const out = await ok(
    git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-*', 'refs/remotes/origin/worktree-*'])
  );
  const names = new Set();
  for (const line of String(out || '').trim().split('\n')) {
    const name = line.trim().replace(/^origin\//, '');
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * The branch's tip, local ref or origin's, fully qualified — lib/inmain.js's `tipOf`,
 * and for the reason given there: a bare name will resolve a *file* of that name, and a
 * name that is both a local and a remote branch is an ambiguity git resolves with a
 * warning nobody reads.
 */
async function tipOf(dir, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const sha = await refTip(dir, ref);
    if (sha) return { sha, ref };
  }
  return null;
}

/** The base to measure against: `origin/main` if this checkout has it, else `main`. */
async function pickBase(dir, base) {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const sha = await refTip(dir, ref);
    if (sha) return { ref, name: ref.startsWith('refs/remotes/') ? `origin/${base}` : base };
  }
  return null;
}

/**
 * How many commits this branch has that the base does not, the newest subject, and when
 * that newest commit was made.
 *
 * The count is fact 2 and the subject is for the card: "1 commit — *bc-5lcc: prove the
 * squash path*" is a sentence somebody can decide about, where a bare sha is a thing
 * they would have to go and look up on a phone.
 *
 * The date is fact 4 — see `GRACE_MS`. It is the *committer* date rather than the author
 * date, because a rebase is work happening now and an author date it carried in from a
 * week ago is not evidence of anything.
 *
 * `null` when git could not answer, which is not the same as zero and must not read as
 * it — the caller skips rather than deciding.
 */
export async function commitsAhead(dir, tip, baseRef) {
  const count = await ok(git(dir, ['rev-list', '--count', `${baseRef}..${tip}`]));
  if (count === null) return null;
  const ahead = Number(String(count).trim());
  if (!Number.isFinite(ahead)) return null;
  if (!ahead) return { ahead, subject: '', committedAt: null };
  const line = String((await ok(git(dir, ['log', '-1', '--format=%s%x00%cI', tip]))) || '');
  const [subject = '', at = ''] = line.split('\0');
  const committedAt = Date.parse(at.trim());
  return { ahead, subject: subject.trim(), committedAt: Number.isFinite(committedAt) ? committedAt : null };
}

/**
 * What GitHub knows about this branch: `{ merged }` or `{ open }` or neither.
 *
 * Asked with `--head`, which matches the `headRefName` GitHub keeps on the pull request
 * forever — so it answers about a branch whose ref was deleted by the merge, which is
 * every branch a card merge has touched and precisely the case that matters.
 *
 * Throws are the caller's to catch: `gh` failing is not evidence that nothing merged,
 * and treating it as one would card a bead over a squash merge that went perfectly.
 */
export async function githubState(dir, branch) {
  const rows = (await pr.list(dir, { state: 'all', head: branch, limit: 20 })) || [];
  const mine = rows.filter((r) => r.branch === branch);
  const merged = mine.find((r) => String(r.state || '').toUpperCase() === 'MERGED');
  if (merged) return { merged };
  const open = mine.find((r) => String(r.state || '').toUpperCase() === 'OPEN');
  if (open) return { open };
  return {};
}

/**
 * The fingerprint, keyed by branch — lib/inmain.js's `askMark`, in its own namespace so
 * the two sweeps cannot silence each other.
 *
 * It goes in the closed bead's notes, which is the only place it can go: the card is a
 * different bead and gets answered and closed, so a guard that read the card's existence
 * would re-file it the moment it was answered — forever, on a question already settled.
 */
export const askMark = (branch) => `<!-- beadcause:notinmain ${branch} -->`;

/**
 * The mark that takes the ask back, written by `followNotInMain` when it closes a card
 * because a pull request turned up **open** for the branch.
 *
 * It exists because the fingerprint is otherwise permanent and the reason for cancelling
 * the card is not. An *open* pull request is somebody looking, and the sweep already
 * treats that as a reason to say nothing — but it says nothing *without writing a mark*,
 * so it comes back to the same branch every hour and cards it if the pull request is
 * later closed unmerged. A card corrected by an open pull request has to be returned to
 * that state, or a delivery that is refused a week later is stranded work no sweep will
 * ever mention again.
 *
 * Not written when the correction is a **merge**, and that asymmetry is the point: a
 * merge settles the question for good, so the mark is left standing and the branch costs
 * no further `gh` call. Only the reversible correction is reversed.
 */
export const clearMark = (branch) => `<!-- beadcause:notinmain-cleared ${branch} -->`;

/** Every field of a bead that could carry the mark, including one somebody moved by hand. */
const MARK_FIELDS = ['notes', 'description', 'design', 'close_reason'];

/**
 * Has this bead already been asked about this branch? Read off the row `bd list` returned.
 *
 * **The last mark wins**, which is what makes `clearMark` work: the fields are read in
 * one order every time and compared by position, so an ask appended after a clear is an
 * ask again. `bd.appendNotes` only ever appends, so position is chronology.
 */
export const alreadyAsked = (bead, branch) => {
  const text = MARK_FIELDS.map((f) => String(bead?.[f] || '')).join('\n');
  const asked = text.lastIndexOf(askMark(branch));
  return asked >= 0 && asked > text.lastIndexOf(clearMark(branch));
};

/**
 * Is this closed bead one to look at?
 *
 * `human` is out because it is already in the inbox and a second question about it is
 * noise; `unendorsed` is out because nothing may open a session on it, so the commission
 * this card offers could not be acted on. The window is the last of the three and is the
 * cheapest, so it is asked first.
 */
export function isCandidate(bead, { now = Date.now(), days = RECENT_DAYS } = {}) {
  if (String(bead?.status || '').toLowerCase() !== 'closed') return false;
  const closed = Date.parse(bead?.closed_at || bead?.updated_at || '');
  if (!Number.isFinite(closed) || now - closed > days * 86400000) return false;
  const labels = (bead?.labels || []).map((l) => String(l).trim());
  if (labels.includes(HUMAN_LABEL) || labels.includes(UNENDORSED)) return false;
  return true;
}

/**
 * When GitHub was asked, in a form that reads on a phone and cannot be misread as local
 * time — the `Z` is load-bearing, since a bead's own comment timestamps render in UTC
 * while every brief and every card around them talks in ADT.
 */
export const stampOf = (at) => {
  const ms = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(ms)) return 'when this was filed';
  return `when this was filed, at ${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)}Z`;
};

/** The title of the card bead. Says the fact, names both the branch and the bead. */
export const strandedTitle = (id, branch) => `${branch} never reached main — ${id} is closed over it`;

/**
 * That title, read back — the branch and the bead this card is about.
 *
 * **The card's own title is the card→branch mapping, and that is deliberate.** The
 * sibling sweep keeps its mapping in `~/.config/beadcause/sweep-cards.json` and bc-xl7n.35
 * is the bead about what that costs: eight of thirteen cards filed in one day outlived
 * their record, and a card whose record is gone can never be amended or closed by the
 * thing that filed it. There is nothing to lose here, because every field the follow-up
 * needs is already in a title written to be read by a person — so the recovery path and
 * the ordinary path are the same path, and there is no second one to go stale.
 *
 * Anchored on `worktree-` because that is the only prefix `worktreeBranches` ever
 * returns, and on the whole string at both ends, so a bead somebody titled *about* one of
 * these cards is not mistaken for one.
 */
export const CARD_TITLE_RE = /^(worktree-\S+) never reached main — (\S+) is closed over it$/;

/** `{ branch, id }` for a card of this sweep's, or `null` for any other bead. */
export function cardSubject(title) {
  const m = CARD_TITLE_RE.exec(String(title || '').trim());
  return m ? { branch: m[1], id: m[2] } : null;
}

/**
 * The card: markdown with a `decision` block in it, filed as the new bead's description.
 *
 * **No option is recommended.** The fact — that a bead was closed over work that is not
 * in `main` — says nothing about whether the work is still worth having. bc-0nq8's
 * commit was a whole test wrapper that would land almost as it stands; another bead's is
 * a half-finished spike its own session gave up on, and they look identical from here.
 *
 * Everything interpolated into the YAML is machine-made — a ref name, a bead id, a
 * count — and the one piece of prose, the commit subject, stays in the markdown above
 * it, where a stray quote is a stray quote rather than a block that will not parse. The
 * two values that begin with the branch name are double-quoted, because a YAML plain
 * scalar may not start with a backtick and lib/decision.js reports that as an error the
 * card renders as a free-text box — a question with no buttons on it.
 */
export function strandedCard(id, branch, facts, baseName) {
  const { ahead = 0, subject = '', tip = '', askedAt = null } = facts || {};
  const sha = String(tip).slice(0, 8);
  const commits = `${ahead} commit${ahead === 1 ? '' : 's'}`;
  const clean = subject ? subject.replace(/[*_`]/g, '') : '';
  const stamp = stampOf(askedAt);
  return `## \`${branch}\` has ${commits} that are not in \`${baseName}\`

${id} is **closed**, and the branch its session worked on never landed: nothing in
\`${baseName}\` holds it, and GitHub had no pull request for it ${stamp} — not merged, not
open, not refused. The tip is \`${sha}\`${clean ? ` — *${clean}*` : ''}.

That last sentence has an age, which is why it says when it was taken: the reading is a
point in time and a delivery pushes its branch some minutes before it opens the pull
request, so a card written inside that gap is wrong by the time anybody reads it. This
one is re-asked every sweep, and closes itself with a note if a pull request turns up.

That combination reads as finished from every screen there is. A closed bead with a
close reason is the least suspicious thing in the tracker, so this is usually found
weeks later, by a session going to reuse something that turns out not to exist.

**Nothing has been closed, reopened, merged or pushed**, and the sweep that found this
cannot do any of those — see lib/notinmain.js. ${id} is still closed and stays that way
unless you say otherwise.

**Land it** keeps *this* bead open and hands it to \`bd ready\` as ordinary work: a
session gets the branch, rebases or re-does it against today's \`${baseName}\`, and delivers
it — or says on ${id} why it cannot. **Let it go** closes this and leaves ${id} closed,
with the finding on its thread so the next reader knows the work is not there.

One thing this cannot tell apart from lost work: a branch whose commits reached
\`${baseName}\` by being cherry-picked or re-done on another branch. If that is what happened,
let it go.

\`\`\`decision
question: "\`${branch}\` has ${commits} that never reached ${baseName} — ${id} is closed over it. Land it?"
options:
  - id: land-it
    label: Land it — deliver the branch
    response: "Landing it: a session will rebuild \`${branch}\` against ${baseName} and deliver it, or say why it cannot."
    hint: Keeps this open as ordinary work
    closes: false
  - id: let-it-go
    label: Let it go — the work is abandoned
    response: "Let go: \`${branch}\` is not worth landing, and ${id} stays closed over it."
    hint: ${id} stays closed
\`\`\`
`;
}

/** The line on the closed bead's thread. The card carries the reasoning; this is the fact. */
export const strandedComment = (branch, cardId, baseName) =>
  `This is closed over \`${branch}\`, which is not in \`${baseName}\` and has no pull request. ` +
  `Nothing here has been reopened — the finding is ${cardId}, in the inbox, and the choice is whether to land it.`;

/**
 * What the card bead is worth, and why it is not higher.
 *
 * P2 is the cap on anything an agent files unasked (see bin/file.js). This is filed by
 * the daemon rather than by a worker, and the same restraint applies for the same
 * reason: it may not outrank the work Adam chose, and he can raise it in a tap.
 */
const CARD_PRIORITY = 2;

/**
 * Sweep one workspace against one checkout. Returns what it flagged and what it did not.
 *
 * `rows` exists for the tests and for a caller that has already read the tracker this
 * tick; everything else pays for one `bd list --status=closed`.
 */
export async function sweepNotInMain(
  bd,
  ws,
  dir,
  { base = 'main', rows = null, now = Date.now(), days = RECENT_DAYS, maxAsks = MAX_ASKS, graceMs = GRACE_MS } = {}
) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [], held: [], unasked: 0 };

  // GitHub before anything, because fact 3 is not optional: without it every squash
  // merge in the fortnight looks like abandoned work, and the sweep's first act would be
  // to file a card about each one.
  const gh = await pr.available();
  if (!gh.ok) {
    out.reason = gh.reason;
    return out;
  }

  let main;
  try {
    main = await mainCheckout(dir);
  } catch (err) {
    out.reason = `${dir} is not a git checkout — ${String(err.message || err).split('\n')[0]}`;
    return out;
  }

  const baseRef = await pickBase(main, base);
  if (!baseRef) {
    out.reason = `neither origin/${base} nor ${base} is a ref in ${main}`;
    return out;
  }

  const branches = await worktreeBranches(main);
  if (!branches.length) {
    // Not a failure: a checkout that has never had a worktree cut from it owns no branch
    // this could be about, and `ok` stays true so the caller says nothing at all.
    out.ok = true;
    return out;
  }

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.listStatus(ws, 'closed');
    } catch (err) {
      out.reason = `bd list failed — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  out.ok = true;
  let asked = 0;

  for (const bead of beads || []) {
    if (!isCandidate(bead, { now, days })) continue;
    const owned = branches.filter((b) => ownsBranch(bead.id, b));
    if (!owned.length) continue;
    out.checked += 1;

    for (const branch of owned) {
      // The fingerprint before git, because it is a string comparison against a row
      // already in hand and everything below it is a subprocess. After the first sweep
      // this is the answer for nearly every branch it looks at.
      if (alreadyAsked(bead, branch)) {
        out.skipped.push({ id: bead.id, branch, why: 'it already carries the ask about this branch', quiet: true });
        continue;
      }

      const tip = await tipOf(main, branch);
      if (!tip) {
        out.skipped.push({ id: bead.id, branch, why: 'no local or origin ref by that name', quiet: true });
        continue;
      }

      const ahead = await commitsAhead(main, tip.sha, baseRef.ref);
      if (!ahead) {
        out.skipped.push({ id: bead.id, branch, why: 'git could not count what the branch is ahead by' });
        continue;
      }
      if (!ahead.ahead) {
        out.skipped.push({ id: bead.id, branch, why: `nothing on it that ${baseRef.name} does not have`, quiet: true });
        continue;
      }

      // Fact 4 — see `GRACE_MS`. Held rather than skipped: no fingerprint is written, so
      // this branch is looked at again next sweep and carded then if it is still
      // stranded. Counted with the ones over the cap for the same reason, which is that
      // a sweep quietly declining to say something is indistinguishable from one that
      // found nothing.
      if (graceMs > 0 && Number.isFinite(ahead.committedAt) && now - ahead.committedAt < graceMs) {
        const mins = Math.max(1, Math.round((now - ahead.committedAt) / 60000));
        out.held.push({ id: bead.id, branch, why: `its newest commit is ${mins} minute${mins === 1 ? '' : 's'} old — a delivery in flight looks exactly like this` });
        continue;
      }

      if (asked >= maxAsks) {
        // No fingerprint is written, so this branch is simply first in line next
        // interval. Counted rather than listed: on the first sweep it is the whole
        // backlog and a line each would bury everything else the tick had to say.
        out.unasked += 1;
        continue;
      }
      asked += 1;

      let state;
      try {
        state = await githubState(main, branch);
      } catch (err) {
        out.skipped.push({ id: bead.id, branch, why: `could not ask GitHub about it — ${String(err.message || err).split('\n')[0]}` });
        continue;
      }
      if (state.merged) {
        out.skipped.push({ id: bead.id, branch, why: `merged as #${state.merged.number} — squashed, most likely, since nothing in ${baseRef.name} holds it`, quiet: true });
        continue;
      }
      if (state.open) {
        out.skipped.push({ id: bead.id, branch, why: `#${state.open.number} is open for it — somebody is already looking`, quiet: true });
        continue;
      }

      const facts = { ahead: ahead.ahead, subject: ahead.subject, tip: tip.sha, askedAt: now };
      let cardId = null;
      // Under the P0 the stranded bead itself belongs to, or the unsorted backlog — see
      // lib/homing.js. This card is the case bc-rfnr.8 was filed over: a parentless
      // `human` card is not merely held by the dispatch gate, it is *off the inbox*,
      // because bc-rfnr.2 draws only what descends from a P0 you own. A question about
      // a branch nobody merged, filed to a screen that will not show it, is this sweep
      // reporting into a void.
      const { parent } = await homeIn(bd, ws, { from: bead.id });
      // And the provenance edge goes when the home *is* the stranded bead — which is
      // every time that bead is itself a root, since a root is above itself. bd holds
      // one edge per pair and refuses a `discovered-from` over a `parent-child`, so
      // asking for both fails the whole create and the card lands with no parent, which
      // is the exact failure this call site exists to prevent. See lib/filing.js's
      // `withDiscoveredFrom` — bc-xl7n.65.
      const deps = withDiscoveredFrom([], bead.id, { parent });
      try {
        // The card first — see the header. Nothing else here is durable, so a creation
        // that fails must leave the tracker exactly as it found it.
        cardId = await bd.create(ws, {
          title: strandedTitle(bead.id, branch),
          body: strandedCard(bead.id, branch, facts, baseRef.name),
          priority: CARD_PRIORITY,
          type: 'task',
          labels: [HUMAN_LABEL],
          deps,
          parent,
        });
      } catch (err) {
        out.skipped.push({ id: bead.id, branch, why: `could not file the finding — ${String(err.message || err).split('\n')[0]}` });
        continue;
      }
      if (!cardId) {
        out.skipped.push({ id: bead.id, branch, why: 'the tracker took the finding and gave back no id' });
        continue;
      }

      try {
        // The fingerprint, second, on the *closed* bead: this is what stops the same
        // finding being filed again every interval for as long as the branch exists.
        await bd.appendNotes(ws, bead.id, `${askMark(branch)}\n${strandedComment(branch, cardId, baseRef.name)}\n`);
      } catch (err) {
        out.skipped.push({
          id: bead.id,
          branch,
          why: `filed ${cardId} but could not mark ${bead.id} as asked, so it may be asked again — ${String(err.message || err).split('\n')[0]}`,
        });
      }

      try {
        await bd.comment(ws, bead.id, strandedComment(branch, cardId, baseRef.name));
      } catch {
        /* A courtesy on a closed bead. The card is the record and it is already filed. */
      }

      out.flagged.push({
        id: bead.id,
        title: bead.title || '',
        card: cardId,
        branch,
        tip: tip.sha,
        ahead: ahead.ahead,
        base: baseRef.name,
      });
    }
  }

  return out;
}

/**
 * How many open cards may be re-asked about GitHub in one follow-up.
 *
 * The same shape as `MAX_ASKS` and for the same reason, but a much smaller number,
 * because the population is different: the cards this walks are the ones sitting in the
 * inbox right now, and if there are more than a handful of them the inbox has a bigger
 * problem than the age of any one reading. Nothing is dropped — a card not re-asked about
 * is first in line on the next follow-up, since nothing about it is written down.
 */
export const MAX_FOLLOW_ASKS = 8;

/** The close reason on a card the world has overtaken. It is the whole correction. */
export const correctedReason = (branch, state, baseName) =>
  state.merged
    ? `Wrong when it was asked: \`${branch}\` was merged as #${state.merged.number}. The reading behind this card was taken before that pull request existed — see lib/notinmain.js — and the branch is not stranded work. Nothing was reopened and nothing needs answering.`
    : state.open
      ? `Wrong when it was asked: #${state.open.number} is open for \`${branch}\`, so somebody is already looking at it. The reading behind this card was taken in the gap between a delivery pushing its branch and opening its pull request — see lib/notinmain.js — and there is nothing here to decide.`
      : `Wrong when it was asked: everything on \`${branch}\` is now in \`${baseName}\`. The reading behind this card predates whatever landed it, and there is nothing left to land.`;

/** The line on the *closed* bead's thread, taking back the one the sweep put there. */
export const correctedComment = (branch, cardId, state, baseName) =>
  `Taking that back: ${cardId} said \`${branch}\` had never reached \`${baseName}\`, and it has — ` +
  `${state.merged ? `merged as #${state.merged.number}` : state.open ? `#${state.open.number} is open for it` : `\`${baseName}\` holds all of it now`}. ` +
  `${cardId} is closed and there is nothing to answer.`;

/**
 * Re-ask about every card this sweep has open, and close the ones the world has overtaken.
 *
 * `sweepNotInMain` takes a reading and files a card; **the card then outlives the reading
 * by days and says nothing about when it was taken**, which is bc-xl7n.63 and was measured
 * being wrong eight minutes after it was written. `GRACE_MS` kills the common case at the
 * filing end and this is the other end: the sentence on an open card is checked again on
 * every sweep, and a card whose central claim has stopped being true is closed with a
 * reason saying so rather than left for Adam to answer a question about a state that no
 * longer exists.
 *
 * It is also what keeps the two sweeps in this family from asking incompatible things
 * about one branch. lib/sweepcard.js cards a branch *because* it has a pull request that
 * will not merge; this one cards a branch *because* it has none. Both were open on
 * `worktree-reenter-gate-f31f` on 2026-08-14, offering "land it / let it go" and "which
 * side wins" about the same work. There is no cross-check between them here and there
 * does not need to be — the moment a pull request exists this card cannot survive its
 * next follow-up, and that is the only condition under which the other sweep files at
 * all. Consulting `sweep-cards.json` directly was the obvious alternative and was not
 * taken: bc-xl7n.35 is open about that file losing records, so a check against it would
 * be a guard that fails open exactly when the inbox is worst.
 *
 * **The card is closed rather than amended**, which is the difference from
 * `followSweepCards`. There it amends because the card is a running report on merges that
 * are still moving and there is more to say. Here the card is a single question with two
 * buttons on it, and once a pull request exists neither button means anything: "land it"
 * would commission a session to rebuild a branch that is already in review, and "let it
 * go" would record a decision to abandon work nobody is abandoning. A question whose
 * options have both become wrong is not a question to reword.
 *
 * **Nothing here reopens, merges, pushes or deletes anything either**, and it writes to
 * exactly two beads: the card it closes and the closed bead whose thread pointed at it.
 * Every failure is a sentence in the returned object rather than a throw, for the reason
 * the sweep gives.
 */
export async function followNotInMain(
  bd,
  ws,
  dir,
  { base = 'main', cards = null, maxAsks = MAX_FOLLOW_ASKS } = {}
) {
  const out = { ok: false, reason: '', checked: 0, corrected: [], skipped: [], unasked: 0 };

  const gh = await pr.available();
  if (!gh.ok) {
    out.reason = gh.reason;
    return out;
  }

  let main;
  try {
    main = await mainCheckout(dir);
  } catch (err) {
    out.reason = `${dir} is not a git checkout — ${String(err.message || err).split('\n')[0]}`;
    return out;
  }

  const baseRef = await pickBase(main, base);
  if (!baseRef) {
    out.reason = `neither origin/${base} nor ${base} is a ref in ${main}`;
    return out;
  }

  let open = cards;
  if (!open) {
    try {
      open = await bd.listHuman(ws);
    } catch (err) {
      out.reason = `bd human list failed — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  out.ok = true;
  let asked = 0;

  for (const card of open || []) {
    const subject = cardSubject(card?.title);
    if (!subject) continue;
    const cardId = String(card.id || '');
    if (!cardId) continue;
    out.checked += 1;

    if (asked >= maxAsks) {
      out.unasked += 1;
      continue;
    }
    asked += 1;

    // GitHub first and unconditionally, because it is the claim the card actually makes
    // and it is the only witness that survives the branch itself: a merge deletes the
    // ref, so `tipOf` returning nothing is the *expected* shape of the case this most
    // wants to catch and must not be read as "there is nothing to check".
    let state;
    try {
      state = await githubState(main, subject.branch);
    } catch (err) {
      out.skipped.push({ card: cardId, branch: subject.branch, why: `could not ask GitHub about it — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }

    if (!state.merged && !state.open) {
      // Still no pull request. The other half of the card's claim is that the base does
      // not hold the commits, and that can stop being true on its own — a cherry-pick, a
      // re-do on another branch, somebody merging it by hand.
      const tip = await tipOf(main, subject.branch);
      if (!tip) {
        out.skipped.push({ card: cardId, branch: subject.branch, why: 'no pull request, and the ref is gone — nothing left to re-read', quiet: true });
        continue;
      }
      const ahead = await commitsAhead(main, tip.sha, baseRef.ref);
      if (!ahead) {
        out.skipped.push({ card: cardId, branch: subject.branch, why: 'git could not count what the branch is ahead by' });
        continue;
      }
      if (ahead.ahead) {
        out.skipped.push({ card: cardId, branch: subject.branch, why: 'still true — no pull request and the base still does not have it', quiet: true });
        continue;
      }
    }

    try {
      await bd.close(ws, cardId, correctedReason(subject.branch, state, baseRef.name));
    } catch (err) {
      out.skipped.push({ card: cardId, branch: subject.branch, why: `could not close it — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }

    // Only for the reversible correction — see `clearMark`. Before the comment because it
    // is the one that changes what a later sweep does; the comment is a courtesy.
    let cleared = false;
    if (state.open) {
      try {
        await bd.appendNotes(ws, subject.id, `${clearMark(subject.branch)}\n${correctedComment(subject.branch, cardId, state, baseRef.name)}\n`);
        cleared = true;
      } catch {
        /* The card is closed either way. The cost of failing here is that a pull request
           later refused unmerged goes unmentioned, which is what the mark was for. */
      }
    }

    try {
      await bd.comment(ws, subject.id, correctedComment(subject.branch, cardId, state, baseRef.name));
    } catch {
      /* A courtesy on a closed bead. The correction is the close reason and it is done. */
    }

    out.corrected.push({
      card: cardId,
      id: subject.id,
      branch: subject.branch,
      why: state.merged ? `merged as #${state.merged.number}` : state.open ? `#${state.open.number} is open for it` : `${baseRef.name} holds all of it`,
      cleared,
    });
  }

  return out;
}

/** One line for the log. Empty when the follow-up found nothing worth saying. */
export function describeFollowNotInMain(result) {
  if (!result.ok) return result.reason ? `not-in-main follow-up skipped — ${result.reason}` : '';
  const parts = [];
  if (result.corrected.length) {
    const named = result.corrected.map((c) => `${c.card} (${c.branch} — ${c.why})`).join(', ');
    const n = result.corrected.length;
    parts.push(`closed ${n} not-in-main card${n === 1 ? '' : 's'} that had stopped being true — ${named}`);
  }
  if (result.unasked) {
    // Said for the reason the sweep says it: a follow-up that quietly stopped half way
    // reads exactly like one that found every card still true.
    const one = result.unasked === 1;
    parts.push(
      `${parts.length ? 'and ' : ''}${result.unasked} more card${one ? '' : 's'} ${one ? 'was' : 'were'} not re-asked about this sweep — ` +
        `${one ? 'it is' : 'they are'} first in line next time`
    );
  }
  return parts.join(', ');
}

/** One line for the log and the card. Empty when the sweep found nothing worth saying. */
export function describeNotInMain(result) {
  if (!result.ok) return result.reason ? `not-in-main sweep skipped — ${result.reason}` : '';
  const parts = [];
  if (result.flagged.length) {
    const named = result.flagged.map((f) => `${f.id} (${f.branch} → ${f.card})`).join(', ');
    parts.push(
      `filed ${result.flagged.length} finding${result.flagged.length === 1 ? '' : 's'} about closed beads whose branch never reached main — ${named}`
    );
  }
  const held = (result.held || []).length;
  if (held) {
    const one = held === 1;
    parts.push(
      `${parts.length ? 'and ' : ''}${held} branch${one ? '' : 'es'} ${one ? 'was' : 'were'} too freshly committed to call stranded — ` +
        `${one ? 'a delivery in flight looks like that' : 'a delivery in flight looks like those'}, and ${one ? 'it is' : 'they are'} looked at again next sweep`
    );
  }
  if (result.unasked) {
    const one = result.unasked === 1;
    parts.push(
      `${parts.length ? 'and ' : ''}${result.unasked} more branch${one ? '' : 'es'} ${one ? 'was' : 'were'} not asked about this sweep — ` +
        `${one ? 'it is' : 'they are'} first in line next time`
    );
  }
  return parts.join(', ');
}
