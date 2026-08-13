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
 * Three facts, and each of them removes a way of being wrong:
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
 * How many commits this branch has that the base does not, and the newest subject.
 *
 * The count is fact 2 and the subject is for the card: "1 commit — *bc-5lcc: prove the
 * squash path*" is a sentence somebody can decide about, where a bare sha is a thing
 * they would have to go and look up on a phone.
 *
 * `null` when git could not answer, which is not the same as zero and must not read as
 * it — the caller skips rather than deciding.
 */
export async function commitsAhead(dir, tip, baseRef) {
  const count = await ok(git(dir, ['rev-list', '--count', `${baseRef}..${tip}`]));
  if (count === null) return null;
  const ahead = Number(String(count).trim());
  if (!Number.isFinite(ahead)) return null;
  const subject = ahead ? String((await ok(git(dir, ['log', '-1', '--format=%s', tip]))) || '').trim() : '';
  return { ahead, subject };
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

/** Every field of a bead that could carry the mark, including one somebody moved by hand. */
const MARK_FIELDS = ['notes', 'description', 'design', 'close_reason'];

/** Has this bead already been asked about this branch? Read off the row `bd list` returned. */
export const alreadyAsked = (bead, branch) =>
  MARK_FIELDS.some((f) => String(bead?.[f] || '').includes(askMark(branch)));

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

/** The title of the card bead. Says the fact, names both the branch and the bead. */
export const strandedTitle = (id, branch) => `${branch} never reached main — ${id} is closed over it`;

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
  const { ahead = 0, subject = '', tip = '' } = facts || {};
  const sha = String(tip).slice(0, 8);
  const commits = `${ahead} commit${ahead === 1 ? '' : 's'}`;
  const clean = subject ? subject.replace(/[*_`]/g, '') : '';
  return `## \`${branch}\` has ${commits} that are not in \`${baseName}\`

${id} is **closed**, and the branch its session worked on never landed: nothing in
\`${baseName}\` holds it, and GitHub has no pull request for it — not merged, not open, not
refused. The tip is \`${sha}\`${clean ? ` — *${clean}*` : ''}.

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
  { base = 'main', rows = null, now = Date.now(), days = RECENT_DAYS, maxAsks = MAX_ASKS } = {}
) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [], unasked: 0 };

  // GitHub before anything, because fact 4 is not optional: without it every squash
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

      const facts = { ahead: ahead.ahead, subject: ahead.subject, tip: tip.sha };
      let cardId = null;
      try {
        // The card first — see the header. Nothing else here is durable, so a creation
        // that fails must leave the tracker exactly as it found it.
        cardId = await bd.create(ws, {
          title: strandedTitle(bead.id, branch),
          body: strandedCard(bead.id, branch, facts, baseRef.name),
          priority: CARD_PRIORITY,
          type: 'task',
          labels: [HUMAN_LABEL],
          deps: [`discovered-from:${bead.id}`],
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
  if (result.unasked) {
    const one = result.unasked === 1;
    parts.push(
      `${parts.length ? 'and ' : ''}${result.unasked} more branch${one ? '' : 'es'} ${one ? 'was' : 'were'} not asked about this sweep — ` +
        `${one ? 'it is' : 'they are'} first in line next time`
    );
  }
  return parts.join(', ');
}
