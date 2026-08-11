/**
 * One pull request, one session resolving it.
 *
 * *Resolve conflicts* on the full-screen PR view opens a session on the branch whose
 * whole job is the merge — see `conflictPromptFor` in lib/session.js. On 2026-08-11 one
 * press of it produced **two**, both briefed identically, both told (correctly, for one
 * of them) to work in the worktree the branch was already checked out in. They merged
 * `main` into the same tree at the same time, and the damage was not a conflict marker
 * somebody would notice: one session's `git merge --abort` landed between the other's
 * resolution and its `git add && git commit`, so commit 2183762 carried **unresolved
 * conflict markers into `public/console.js`** with two parents and a perfectly ordinary
 * merge-commit shape. `test/dismissed.mjs` went 2/16. It was caught by a human reading
 * the diff, and the repair had to check that `main`'s side was genuinely still in the
 * tree — an aborted merge can reset the index and still commit, which silently reverts
 * everything the base added while looking like a normal merge. That is bc-utyr.
 *
 * So the second press must not open a second window. What it does instead is the useful
 * half of what it was asking for: it **speaks to the session that already has this pull
 * request**, which is a thing the daemon can do (`messageSession`, lib/session.js) and
 * which answers the question the press was really asking — *is anything happening?*
 *
 * Three states, and the point of the file is that they are three rather than two:
 *
 * 1. **Nothing is on it.** Open a window, and remember the handle.
 * 2. **Something is on it and answers.** The nudge lands in that window's TUI and the
 *    caller is told which session took it. No second window.
 * 3. **Something is on it and cannot be asked.** An iTerm too old to report a session
 *    id gives a record with no handle, and "I cannot ask" is not "it is gone" — the
 *    same distinction `reclaim` keeps in lib/advocate.js, and for the same reason:
 *    treating it as gone is what opens the second window. So it is refused, with the
 *    age said out loud, and the record ages out by itself (`BLIND_MS`) rather than
 *    stranding the button for good.
 *
 * **Everything for one pull request is serialised** — `underLock` — and that is not
 * belt-and-braces, it is the actual shape of the incident. One press produced two
 * requests within a moment of each other. A check-then-launch with an `await` in the
 * middle would let both pass the check before either had anything to find, which is
 * exactly the race that put markers in a commit. Under the lock the second request
 * arrives after the first has a handle to hand it, so it becomes case 2.
 *
 * **In memory, never on disk**, for the reason lib/presence.js gives about a phone's
 * whereabouts: a handle is worth exactly as long as the iTerm that holds it, and a
 * record surviving a daemon restart would only ever be a claim about a window nobody
 * can address any more. A restart forgets, the next press opens a window, and that is
 * the correct answer to "nothing here knows of a session on this".
 */
import { messageSession } from './session.js';

/**
 * How long a record with a handle is kept at all.
 *
 * Garbage collection and nothing more: a handle is asked on every press, so a session
 * that exited hours ago answers `missing` and is forgotten on the spot whatever this
 * says. It is here so a daemon up for a fortnight is not holding a map of every pull
 * request anyone ever pressed the button on.
 */
const TTL_MS = 4 * 60 * 60 * 1000;

/**
 * And how long a record *without* one is believed.
 *
 * This is the number that decides something, because a record with no handle can only
 * be believed or disbelieved — there is nothing to ask. Half an hour is a resolver's
 * job: merge, resolve, run the repo's gate, push. Longer would strand the button on the
 * one Mac where iTerm reports nothing; shorter would let a slow test run turn into a
 * second window, which is the bug.
 */
const BLIND_MS = 30 * 60 * 1000;

/** `${workspace}#${number}` → what is on it. */
const live = new Map();

/** `${workspace}#${number}` → the tail of the queue of requests for it. */
const locks = new Map();

const keyFor = (workspace, number) => `${workspace}#${Number(number)}`;

/**
 * Run `fn` with nothing else running for this pull request.
 *
 * A promise chain per key rather than a flag, because the thing being protected spans
 * an `await` — the whole decide-then-launch — and a flag can only be read, not waited
 * on. Requests queue in arrival order and each one sees what the one before it left.
 *
 * The chain is dropped once nothing is waiting behind it, so a busy day does not leave
 * a resolved promise per pull request behind forever. `fn`'s own failure must not break
 * the chain: a launch that threw is a window that did not open, and the next press has
 * to be able to try.
 */
async function underLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  locks.set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Only if nothing queued behind us — otherwise the next request owns the chain and
    // deleting it here would let a third one overtake it.
    if (locks.get(key) === mine) locks.delete(key);
  }
}

/** What is remembered about the session on one pull request, or null. */
export function find(workspace, number, now = Date.now()) {
  const key = keyFor(workspace, number);
  const rec = live.get(key);
  if (!rec) return null;
  const age = now - new Date(rec.at).getTime();
  if (age > TTL_MS || (!rec.term && age > BLIND_MS)) {
    live.delete(key);
    return null;
  }
  return rec;
}

/** Remember the session that just took a pull request. */
export function remember(workspace, number, { branch = '', dir = '', term = null } = {}, now = new Date()) {
  const rec = {
    workspace,
    number: Number(number),
    branch: String(branch || ''),
    dir: String(dir || ''),
    term: term || null,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  live.set(keyFor(workspace, number), rec);
  return rec;
}

/** Drop what is remembered — a session that answered `missing`, or a test. */
export function forget(workspace, number) {
  return live.delete(keyFor(workspace, number));
}

/** Every session currently believed to be resolving something. Newest first. */
export function list(now = Date.now()) {
  const out = [];
  for (const rec of [...live.values()]) {
    if (find(rec.workspace, rec.number, now)) out.push(rec);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Tests, and nothing else: this is process-lifetime state by design. */
export function reset() {
  live.clear();
  locks.clear();
}

/**
 * What is typed into a session that already has this pull request.
 *
 * One line, for the reason `checkinMessage` is one line: it lands in a window an agent
 * is working in, and six lines of it is six lines to scroll past. It says the press
 * happened rather than inventing an instruction from it — the session's brief has not
 * changed and re-stating it would read as a new task — and it names the one thing a
 * second press usually means, which is that nobody can tell whether this is stuck.
 */
export function nudgeMessage(number, owner = 'Adam') {
  return (
    `** BEADCAUSE ** ${owner} pressed Resolve conflicts on #${number} again — you already have it, ` +
    `so there is nothing new to do and no second session is being opened. ` +
    `If you are stuck, say what on the pull request (\`gh pr comment ${number}\`) and stop; ` +
    `starting a second merge in this tree is what that press must not cause.`
  );
}

/** How long ago, in the words a refusal can use. */
function ago(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'a moment ago';
  if (mins === 1) return 'a minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

/**
 * Get a pull request resolved, without ever getting it resolved twice.
 *
 * `launch` is the thing that actually opens the window — `openConflictSession`, passed
 * in rather than imported so this file owns the decision and not the act, and so a test
 * can assert the decision without an iTerm. It resolves to whatever that returns, and
 * the `term` on it is the handle the next press will be answered with. `branch` comes
 * from the caller's row rather than from that result, which does not carry one: it is
 * only ever quoted back in a sentence, and a sentence naming the wrong branch is worse
 * than one naming none.
 *
 * Resolves to exactly one of:
 *
 *   { opened }              a window was opened; `opened` is `launch`'s result
 *   { reused, note }        a live session was told; nothing was opened
 *   { error, status }       nothing was opened and nothing could be told
 *
 * A throw from `launch` travels out untouched: the caller already knows how to turn
 * iTerm's refusals into an HTTP status, and a failure to open is not a state worth
 * remembering — the record is written only once a window exists.
 *
 * `say` failing is *not* `missing`, the same rule `messageSession` states: macOS
 * refusing the Apple event and the window being gone must not be the same answer,
 * because the second one opens a window. So a refusal is reported as itself.
 */
export async function resolveFor(workspace, number, launch, { branch = '', say = messageSession, owner = 'Adam', now = Date.now() } = {}) {
  return underLock(keyFor(workspace, number), async () => {
    const held = find(workspace, number, now);
    if (held) {
      if (!held.term) {
        return {
          status: 409,
          error:
            `a session was opened on #${number} ${ago(now - new Date(held.at).getTime())} and this iTerm ` +
            `cannot be asked whether it is still there — check the window${held.branch ? ` on ${held.branch}` : ''} ` +
            `rather than opening a second one`,
        };
      }
      let answer;
      try {
        answer = await say(held.term, nudgeMessage(number, owner));
      } catch (err) {
        return { status: err.status || 502, error: `could not reach the session already on #${number} — ${String(err.message || err).split('\n')[0]}` };
      }
      if (answer !== 'missing') {
        return {
          reused: held,
          note:
            `#${number} already has a session on it${held.branch ? `, on ${held.branch}` : ''} — ` +
            `told it you pressed again rather than opening a second one`,
        };
      }
      // Proven gone. This is the only place a record is dropped on evidence rather than
      // on age, and it is the common case: the resolver finished, the window closed.
      forget(workspace, number);
    }

    const opened = await launch();
    remember(workspace, number, { branch, dir: opened?.dir || '', term: opened?.term || null }, new Date(now));
    return { opened };
  });
}
