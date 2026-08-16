/**
 * Bringing a parked conversation back — the other half of lib/parked.js.
 *
 * That file is the record and the argument for why a window waiting on Adam may be
 * closed at all. This one is what makes the argument true: given a parked record and an
 * answer, put the *same agent* back in front of the *same files* with the answer as its
 * next turn.
 *
 * **Why the resume happens at the dispatch seam and not at `/api/respond`.** Answering is
 * one tap on a phone, and the tempting thing is to open the window right there — the
 * answer is in hand, the record is in hand, nothing else has to know. It is the wrong
 * place, twice over. Every gate that decides whether a window may open at all lives on
 * the advocate's tick: attempts, claims, cross-machine leases, the endorsement door, quiet
 * hours, the worker limit, `OBSERVING`. A launch from the answer handler is a launch past
 * all of them, and the first time two Macs answered the same question there would be two
 * windows on one bead — which is the failure bc-2uj4 exists to end. And the answer does
 * not only arrive from `/api/respond`: it arrives from Slack, from the laptop, from `bd`
 * on the command line, and from a bead somebody unblocked by hand. The tracker is the one
 * place all of those meet.
 *
 * So the flow is exactly the flow that already exists, with one lookup added: the answer
 * unblocks the bead, the bead goes ready, the advocate surveys it, and at the moment it
 * would open a window it asks *is there a conversation parked on this bead?* If there is,
 * the window it opens is that conversation continued rather than a new one.
 *
 * ## Three things have to be true, and each has a fallback rather than a failure
 *
 * 1. **The transcript has to exist.** Checked by looking for it, because a session id
 *    whose transcript has been cleared out of `~/.claude/projects` resumes into an empty
 *    conversation that reports success — the one failure mode here that is invisible.
 * 2. **The directory has to exist**, and this is the half worth being precise about.
 *    Measured on Claude Code 2.1.x, `--resume <id>` finds the conversation from *any*
 *    working directory, so the directory is not what locates it. What the directory
 *    supplies is everything the transcript cannot: the branch, the uncommitted edits, the
 *    files every path in that agent's context points at, and the `BEADS_DIR` its login
 *    shell resolves. Resuming in the wrong tree gives an agent a perfect memory of files
 *    that are not there — which is worse than a fresh session, because it will act on it.
 *    A worktree retired into `.claude/worktrees-retired/` is the case this runs into most,
 *    since retiring happens on merge and a parked window is usually parked on the far side
 *    of one, so `unretire` below moves it back before anything tries to resume in it.
 * 3. **The window has to open.** Which is `launch`'s problem, not this file's.
 *
 * Any of those failing falls back to a fresh session on the bead — the behaviour before
 * this existed, so the worst case is the old case — and it is **logged**, never silent. A
 * fresh session that reads as a resume is the one outcome here worth guarding against: it
 * looks identical on the console, and the agent that comes up has no idea it was supposed
 * to know anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcriptFile } from './transcript.js';

const run = promisify(execFile);

/** The attic, relative to the main checkout — the same path lib/tidy.js retires into. */
const RETIRED = path.join('.claude', 'worktrees-retired');
/** And where a live worktree belongs, which is where one comes back to. */
const LIVE = path.join('.claude', 'worktrees');

const git = async (cwd, args) => (await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;

/**
 * The main checkout a worktree belongs to, read off the path rather than asked of git.
 *
 * `mainCheckout` in lib/gitref.js is the proper answer to this question and it is not the
 * one to use here, because it runs `git rev-parse` **inside the directory** — and the
 * directory this is asked about is, in the case that matters, one that has been moved
 * into the attic and is not there any more. A path is still a path when the tree is gone.
 *
 * The convention it reads is beadcause's own and is enforced everywhere else in the repo:
 * a worktree lives at `<main>/.claude/worktrees/<name>`, retired at
 * `<main>/.claude/worktrees-retired/<name>` (`sweepWorktrees` in lib/tidy.js). Null for a
 * directory that is not one of those, which is a session that was opened in a plain
 * checkout — nothing to un-retire, and `prepareResume` treats it as already live.
 */
export function mainOf(dir) {
  const at = String(dir || '').indexOf(`${path.sep}.claude${path.sep}worktree`);
  return at > 0 ? String(dir).slice(0, at) : null;
}

/**
 * Put a retired worktree back where it was, so a conversation can be resumed in it.
 *
 * **This is the concession, and it is deliberate.** The alternative was to treat a
 * retired worktree as a conversation lost and fall back to a fresh session, which is
 * simpler and costs an hour of context every time — and it would cost it *routinely*,
 * because the ordinary life of a parked window is: deliver, park, branch merges, worktree
 * retires, Adam answers. The attic exists precisely so that a retired tree stays
 * resumable for two days (`ATTIC_DAYS` in lib/tidy.js), and this is the first thing in
 * beadcause that actually resumes one. Leaving it unused would mean the daemon retiring
 * trees into a drawer nothing ever opens.
 *
 * `git worktree move` and never a plain rename: every entry in the attic is still a
 * *registered* worktree, and moving the directory behind git's back leaves the
 * registration pointing at nothing — which breaks `git worktree list` for every other
 * session in the repo, not just this one.
 *
 * Returns the live path when it moved one, null when there was nothing to move — which
 * covers both "the directory is already there" (the common case, and not an error) and
 * "no such entry in the attic" (the tree is genuinely gone). The caller tells those two
 * apart by looking at the directory, because only one of them means fall back.
 */
export async function unretire(main, dir) {
  const name = path.basename(String(dir || ''));
  if (!name) return null;
  // Already live. Nothing to do, and saying so as `null` rather than as the path keeps
  // the return value meaning one thing: *this call moved something*.
  if (fs.existsSync(dir)) return null;
  const from = path.join(main, RETIRED, name);
  if (!fs.existsSync(from)) return null;
  const to = path.join(main, LIVE, name);
  // A live worktree already sitting on the name means another session took it while this
  // one was in the attic. Refuse rather than move onto it: the resume loses its context,
  // which is recoverable, where clobbering a live checkout is not.
  if (fs.existsSync(to)) return null;
  await git(main, ['worktree', 'move', from, to]);
  // The stamp is what `expireRetired` ages the entry by, and the entry is no longer in
  // the attic. Leaving it behind would leave a note describing a directory that is not
  // there — harmless, but it is exactly the kind of debris that makes the next reader of
  // the attic distrust the notes that do matter.
  fs.rmSync(`${from}.note`, { force: true });
  return to;
}

/**
 * Can this parked conversation actually be brought back?
 *
 * Asked of the pair — id *and* directory — but for two different reasons, and the header
 * has them: the id must have a transcript behind it, and the directory must be the
 * worktree the agent was working in. Only the first is about finding the conversation.
 *
 * `transcriptFile` guesses the cwd's project folder first and then falls back to searching
 * every folder by filename, which is the behaviour wanted here: a session that entered a
 * worktree mid-run has written under two slugs, and either one is proof it exists.
 */
export function resumable(cfg, rec) {
  if (!rec?.sessionId || !rec?.dir) return false;
  if (!fs.existsSync(rec.dir)) return false;
  return Boolean(transcriptFile(cfg, { cwd: rec.dir, sessionId: rec.sessionId }));
}

/**
 * Make the parked conversation resumable if it can be, and say what happened.
 *
 * One call rather than `unretire` then `resumable` at every call site, because the order
 * of those two is load-bearing — checking resumability before restoring the directory
 * answers "no" for every retired worktree — and an order that matters is an order to put
 * in one place rather than in a comment at three.
 *
 * `{ ok, why, restored }`: `ok` decides whether to resume, `why` is the log line for when
 * it is false, and `restored` is the path when a worktree came back out of the attic,
 * which is worth saying out loud because it changed something on disk.
 */
export async function prepareResume(cfg, rec) {
  if (!rec?.sessionId) return { ok: false, why: 'no session id was parked', restored: null };
  let restored = null;
  if (!fs.existsSync(rec.dir)) {
    const main = mainOf(rec.dir);
    if (!main) return { ok: false, why: `${rec.dir} is gone and is not a worktree to bring back`, restored: null };
    try {
      restored = await unretire(main, rec.dir);
    } catch (err) {
      return { ok: false, why: `its worktree could not be brought back — ${err.message.split('\n')[0]}`, restored: null };
    }
    if (!fs.existsSync(rec.dir)) {
      return { ok: false, why: `its worktree ${path.basename(rec.dir)} is gone`, restored: null };
    }
  }
  if (!transcriptFile(cfg, { cwd: rec.dir, sessionId: rec.sessionId })) {
    return { ok: false, why: `no transcript survives for ${rec.sessionId.slice(0, 8)}`, restored };
  }
  return { ok: true, why: '', restored };
}

/**
 * The turn a resumed conversation wakes up to.
 *
 * **Short on purpose, and this is the whole reason resuming beats re-briefing.** The
 * agent already has the brief — the endings, the delivery command, the marker, the file
 * claims, every file it read and every thing it worked out — sitting in its context from
 * the first turn. Handing it the brief again would be handing it a second copy of what it
 * is already holding, which is not neutral: it is a strong signal to start over, and an
 * agent that starts over re-reads the files, re-derives the conclusion, and asks the same
 * question again. The one thing it does *not* have is the answer, so the answer is very
 * nearly the whole of what this says.
 *
 * The one piece of scaffolding kept is the reminder that time has passed and the tree may
 * have moved. That is not padding — a parked window is usually parked across a merge, so
 * `main` genuinely has moved underneath it, and an agent resuming mid-thought would
 * otherwise act on a picture of the repo that is hours old.
 */
export function resumePrompt({ owner = 'Adam', bead = null, question = '', answer = '', parkedAt = null } = {}) {
  const who = owner || 'Adam';
  const ago = parkedAt ? agoPhrase(parkedAt) : '';
  return [
    `**${who} answered.** ${ago ? `You stopped ${ago} and this window was closed while it waited; ` : 'This window was closed while it waited; '}` +
      `the conversation you are reading is your own, resumed where it left off.`,
    '',
    question ? `You asked:\n\n> ${String(question).trim().split('\n').join('\n> ')}\n` : '',
    `${who} says:\n\n> ${String(answer).trim().split('\n').join('\n> ') || '(no text — see the bead)'}`,
    '',
    'Three things changed while you were away, and each is worth a moment before you carry',
    'on:',
    '',
    bead
      ? `1. **The bead was handed back unclaimed.** Answering takes the \`human\` label off and reopens ${bead} without an assignee — that is what put it back in the queue and got this window opened. So \`bd update ${bead} --claim\` first, as you did at the start; a claimed bead is what stops a second window opening on top of you.`
      : '1. **The bead was handed back unclaimed.** Claim it again before you touch anything, as you did at the start.',
    '2. **Time has passed.** `main` may have moved under this worktree and the bead may have',
    '   been edited since you last read it.',
    '3. **The question is closed.** Nothing is waiting on you now except the work itself.',
    '',
    bead ? `Then pick the work on ${bead} back up from here. Everything the brief asked of you still holds — the same endings, the same delivery command, the same marker line. Nothing about them has changed and you do not need them repeated.` : 'Then pick the work back up from here; everything the brief asked of you still holds.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * "an hour ago" — the same coarseness as `answeredAgo` in lib/answered.js, and for the
 * same reason: what a resumed agent needs is the difference between *a minute* and *last
 * Tuesday*, and minutes of precision in that sentence would be noise. Empty string for a
 * timestamp that will not parse, so the caller leaves the phrase out rather than printing
 * "undefined ago".
 */
export function agoPhrase(at, now = new Date()) {
  const then = Date.parse(at || '');
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (mins < 2) return 'a moment ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
