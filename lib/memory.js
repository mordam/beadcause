/**
 * What an agent knows, and what agents tell each other. Eight calls, no repo named.
 *
 *   remember(agent, key, value)   what this kind of agent has learned, for good
 *   recall(agent, key)            read it back — in any repo, in any session
 *   note(agent, key, value)       what it has learned about *the repo it is in*
 *   notes(agent, key)             read that back — from any worktree of that repo
 *   debrief(agent, bead, text)    what happened on *the run it is in*
 *   debriefs(dir, bead)           read that back — how earlier runs at a bead went
 *   post(topic, message)          say something to whoever is listening
 *   read(topic, since)            everything said on a topic since you last looked
 *
 * **The indirection is the feature.** Nothing above names a directory, a ref or a
 * repo, and no caller may pass one. That is what makes the storage replaceable: the
 * day this should be SQLite, or a ref in each agent's own checkout, or a table in
 * beads, the change is this file and nothing else. An agent that had been handed a
 * path would have put that path in its memory, its prompts and its habits, and the
 * migration would be a search across everything anyone ever wrote.
 *
 * **Where it actually lives, for whoever has to debug it.** Three stores, and which one
 * a call uses is the only difference between the three pairs above.
 *
 * **The tier numbers run 1, 2, 4 here, and that is not a typo.** Tier 3 is the agent-owned
 * repo in lib/agentrepo.js — a real checkout an agent is given and nobody designed the
 * contents of — and it is numbered in the same sequence because it is the same question,
 * "where does an agent keep a thing". Renumbering it to make this file read 1-2-3 would
 * break every reference to tier 3 in the README, in lib/advocate.js and in the beads; so
 * the newcomer takes the next free number instead.
 *
 * Tier 2 — the memory that follows the agent, and the blackboard — rides on refs in
 * the common repo (lib/commonrepo.js, `~/.config/beadcause`):
 *
 *   refs/beadcause/memory            one commit per write, tree = <agent>.json
 *   refs/beadcause/bus/<topic>       one commit per message, tree = message.json
 *
 *   git -C ~/.config/beadcause log --format='%aI %s' refs/beadcause/memory
 *   git -C ~/.config/beadcause cat-file -p refs/beadcause/memory:advocate.json
 *   git -C ~/.config/beadcause log refs/beadcause/bus/proposals
 *
 * Tier 1 — what an agent has learned about one codebase — rides on a ref in *that
 * codebase*, beside the foundations and the session logs:
 *
 *   refs/beadcause/agents/<agent>    one commit per write, tree = notes.json
 *
 *   git -C <repo> log --format='%aI %s' refs/beadcause/agents/worker
 *   git -C <repo> cat-file -p refs/beadcause/agents/worker:notes.json
 *
 * Tier 4 — what happened on one run at one bead — ends up in that bead's session archive
 * (lib/sessionlog.js) rather than in a store of its own, and passes through a staging ref
 * in the same repo for the minutes between the write and the archive:
 *
 *   refs/beadcause/debrief/<bead>    staged, consumed and deleted by archiveSession
 *   refs/beadcause/sessions/<bead>   where it lands, as memory.md in the session's tree
 *
 *   git -C <repo> for-each-ref refs/beadcause/debrief   # anything stuck mid-flight
 *   git -C <repo> cat-file -p refs/beadcause/sessions/bc-nib3.4:memory.md
 *
 * **Why more than one, and why none of them is another's optimisation.** Tier 1 came first
 * (bc-goo.1) and is right for knowledge *about a codebase*, which is exactly why
 * nothing could be shared through it: the beadcause advocate and the sophab advocate
 * write into different checkouts and cannot see each other. Tier 2 is the other kind —
 * what an agent *kind* has learned that follows it everywhere, and messages meant for
 * somebody else — and neither of those has a repo it belongs to, so neither can live
 * in one. Collapsing them the other way is worse, and is what shipped for a while:
 * with tier 2 alone, everything an agent worked out about `lib/advocate.js` either
 * followed it into another repo as advice that is false there, or — because the brief
 * says to write only what is "still true next week and in a different repo" — was
 * never written down at all. The second one is the silent failure, and it was the
 * actual behaviour: the store existed, and the knowledge with the most obvious use
 * for it was the knowledge the brief ruled out.
 *
 * **Tier 4 is the same failure a third time, and the section on it says so at length.**
 * Both stores above answer "what is still true next week", and that question rules out
 * what a session knows best at the moment it ends: what happened *this time*. It was
 * therefore written as a note that went stale, or not written at all.
 *
 * **A linked worktree shares its parent's ref store, and that is what makes tier 1
 * usable here at all.** Nearly all work in this repo happens in a worktree under
 * `.claude/worktrees/` that is retired days later, so a note that lived in the
 * worktree would die with it. It does not: a ref outside the per-worktree namespaces
 * lives once, in the common `.git`, so a note written from `worktrees/foo-a3f` is
 * there from the main checkout and from every sibling worktree. `mainCheckout` is what
 * resolves which repo that is, the same way lib/foundation.js resolves the same
 * question for an amendment.
 *
 * **This is a blackboard, not a mailbox and not a conversation.** `post` publishes;
 * `read` is a pull whenever the reader gets round to it. There is no delivery, no
 * addressee and no notification, because git has none to give: refs have no watch,
 * they get packed, and polling `.git/refs` is unreliable. The nudge, when something
 * needs one, is lib/events.js — which is in-memory and un-persisted, and is the
 * exact complement of this. Payload and durability here, wake-up there.
 *
 * **Concurrency is compare-and-swap, and it has to be.** Every write reads the ref
 * tip, builds its object from it, and hands that tip back to `update-ref` as the
 * expected value; git refuses if anyone else landed first, and we retry against the
 * new tip. Two advocates in two repos posting to one topic in the same second is not
 * a hypothetical here — it is the case the whole shape exists for, and tier 1 has its
 * own version of it: a dozen worker sessions in a dozen worktrees of this repo are all
 * one agent kind writing to one ref. The CAS itself lives once, in lib/gitref.js, and
 * is not reimplemented.
 *
 * **Nothing here is fetched or pushed, in either store.** Same refusal lib/sessionlog.js
 * made, and tier 1 is where it bites: these refs sit in a repo that *has* a remote, and
 * agent-written text carries absolute paths and whatever tool output scrolled past. A
 * ref outside `refs/heads/*` and `refs/tags/*` is in no default refspec, so this costs
 * no guard beyond never naming one.
 */
import { ensureRepo } from './commonrepo.js';
import { ownerName } from './owner.js';
import {
  git,
  ok,
  refTip,
  writeTree,
  commitToRef,
  readRefFile,
  listRefTree,
  refHistory,
  mainCheckout,
  deleteRef,
} from './gitref.js';

export const MEMORY_REF = 'refs/beadcause/memory';
export const BUS_PREFIX = 'refs/beadcause/bus';
export const NOTES_PREFIX = 'refs/beadcause/agents';

/**
 * What the agents are told about all this — one copy, quoted into every prompt.
 *
 * A capability an agent has not been told about is a capability it does not have.
 * The allowlist entry and the binary on PATH are necessary and are not sufficient:
 * an agent that never learns the command exists simply never runs it, and from
 * outside that is indistinguishable from it deciding not to.
 *
 * The last paragraph is the part that keeps this from becoming a second, worse
 * tracker. The line beads draws is the one that matters — anything with a work item
 * attached is a bead — so what is left for here is the knowledge that has no work
 * item: a preference, a shape that worked, a dead end not worth walking twice.
 *
 * The roster and `--of` are named here for the same reason as everything else in
 * this string: `agents` has existed since the first version and no agent ever ran
 * it, because nothing ever told one it was there. What the brief also has to carry
 * is *when* another agent's memory is worth reading and what it is worth once read.
 *
 * **Both halves of that are stated, and the write half is the one that replaced a
 * feature** (bc-pud4). The alternative on the table was a curated surface: agents
 * publish the subset they are willing to have read, and the rest stays private. It
 * was rejected because the private half does not exist — an agent should write every
 * memory expecting the others to read it, which is a sentence in a prompt rather
 * than one more store and a question about who curates. (The two stores named
 * below are not that: they are split by *where a fact is true*, and both are
 * readable by every agent.) So the guard moved to where
 * it belongs: not "you are holding something they did not publish", which is a
 * privacy claim and the wrong one, but "this can never be your reason", which is a
 * claim about what a note is worth as evidence. Another agent's memory may be stale,
 * may be about a case unlike yours, and was written with none of your context; it
 * can help justify what you do and it faces the same scrutiny as any other citation.
 *
 * **The two stores are named as two, with the test for choosing between them.** A
 * brief that described one store while two existed would be worse than a brief that
 * described neither: the agent would still write, and it would write everything into
 * whichever one it had been told about. That is not hypothetical either — it is the
 * shape this text had while tier 1 did not exist, and the "still true next week and in
 * a different repo" line, which is correct for tier 2, was silently ruling out every
 * fact about the codebase in front of it.
 *
 * **What this string does not carry, and where each agent has to supply it: a moment
 * for the write half.** The read half is anchored — "check `recall` and `notes` first"
 * names a point in the run that every agent has — and it fires: the console runs
 * `beadcause-memory recall` on the first tool call of most turns. The write half says
 * *what* to keep and never *when*, and the agents that write are exactly the ones whose
 * own brief supplies the when. A worker's numbers it as a closing step before the last
 * message, and it began writing two minutes after that step landed (95 notes and ~85
 * memories inside a day). dispatch's run is one comment and an exit, so its end is
 * unmissable, and its first memory landed an hour after the brief reached it. The
 * console had no such moment — a chat ends by the user not replying — and in three days
 * and twenty-eight conversations it read constantly and wrote nothing. That is bc-sgu4,
 * and the fix was one paragraph in each of `PROTOCOL` and `chatProtocol`, not a change
 * here: the moment is different for every agent, and a generic one stated here would be
 * false for three of the four.
 *
 * **A zero is only evidence if the agent was actually handed this.** The advocate's
 * memory is empty and has never been evidence of anything: `memoryBrief` reaches it
 * through `surveyPrompt` alone, a survey runs only on a tick where the queue is empty
 * of ready beads *and* of workers *and* of epics held by children *and* of beads
 * already in a pull request, and that has never happened on this Mac — `lastProposalAt`
 * is null for all six advocates. Before concluding anything from a silent agent, check
 * that the path that quotes this ever ran.
 */
export const memoryBrief = (owner = ownerName()) => `**You have a memory, and it outlives this run.** Three stores, and none of them is the
tracker: what follows *you* into any repo, what you know about *this* one, and what
happened on *this run*.

    beadcause-memory recall [<key>]              what you have learned, anywhere
    beadcause-memory remember <key> <value...>   keep something that travels with you
    beadcause-memory notes [<key>]               what you know about this repo
    beadcause-memory note <key> <value...>       keep something about this repo
    beadcause-memory debriefs [<bead>]           how previous runs at this bead went
    beadcause-memory debrief <text...>           leave a report on the run you are in
    beadcause-memory read <topic> [--since=N]    what other agents have said
    beadcause-memory post <topic> <message...>   tell them something
    beadcause-memory agents                      which kinds of agent have a memory
    beadcause-memory recall --of=<agent> [<key>] read one of theirs
    beadcause-memory notes --of=<agent> [<key>]  read theirs about this repo

You do not name yourself to it, and you never name a repo or a path to it either; it
already knows who you are, where it is, and — if you were opened on a bead — which one.

**The last pair works only in a window that was opened on a bead**, which is what a worker
and an epic planner are. If you are not one, \`debrief\` will say so and refuse rather than
file a report against a guess, and \`debriefs <bead>\` still reads anybody's.

**Read before you plan, not after you are stuck.** \`debriefs\` first — it is the cheapest
thing in this list and it is about the exact work in front of you: what the last session
at this bead hit, what it ruled out, what it left half-done. Then \`recall\` and \`notes\`
when what you learned last time would change what you do now.

**Which store you write to is two questions.** First: is this a report on *this run*, or a
belief that outlives it?

- **This run — \`debrief\`.** What you actually hit: the dead end, the file that turned out
  to be the real one, the check that already passes, where you stopped and why. It is
  filed against the bead you are on and it is what the next session at this bead reads
  first. It does not have to still be true next week — it is a report, not a rule — and
  that is exactly what neither of the other two can hold.
- **A belief that outlives it** — then the second question: **would this still be true in a
  different repo?**
  - **Yes — \`remember\`.** How ${owner} likes a thing shaped, an approach that worked
    anywhere, a dead end not worth walking again, something about how you yourself go
    wrong. This one follows you, so anything false elsewhere does not belong in it.
  - **No — \`note\`.** How *this* codebase is put together, where its tests live and how
    they are run, the trap in one of its files, what a name means here, why something
    obvious was done the other way. Written from a worktree it is still there from the
    main checkout and from every sibling worktree, and it is still there when this
    worktree is retired.

Getting it wrong is not fatal and it is not free: a repo fact in \`remember\` is advice
you will follow somewhere it is false, a general lesson in \`note\` is one you will
never see again once you are working elsewhere, and a run's narrative in either of them
is advice that goes stale without anybody noticing. **Anything with a work item attached
belongs on a bead, not in any of the three**, and if you cannot say who would benefit from
reading it later, do not write it at all.

**Expect every other agent to read what you write.** There is no private half, in
either store: your whole memory is readable by all of them, so write what you would
stand behind being quoted back at you, and put nothing there you would not want read.

\`agents\` is the roster and \`--of\` reads one of them, in either store — worth it when
another kind of agent has already done the thing you are about to do, or when you are
about to contradict one. **You can only read theirs, never write it**: \`--of\` belongs
to \`recall\` and \`notes\` alone, and \`remember\` and \`note\` always write as you. **What
you find there can never be your reason for something.** It is one agent's conclusion
about its own work — it may be stale, may be about a case unlike yours, and was written
without your context. It can contribute to justifying what you do, and it faces the
same scrutiny as anything else you would cite: say what it is, and say what makes it
true here. What is addressed *to* you is on a topic, via \`read\`.`;

/**
 * A name that is safe as a filename, as a ref component, and as something a human
 * types into a CLI at midnight.
 *
 * Rejected rather than sanitised. Silently turning `advocate/sophab` into
 * `advocate_sophab` writes one agent's memory into another agent's file, and the
 * caller never finds out — whereas an error is read, and the name is fixed once.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function name(kind, value) {
  const s = String(value ?? '');
  if (!NAME.test(s) || s.includes('..')) {
    throw new Error(`bad ${kind} "${s}" — letters, digits, dot, dash, underscore; 64 max; must not start with a symbol`);
  }
  return s;
}

/** One line, short enough to read in `git log --oneline`. */
const clip = (s, n = 72) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/**
 * Retry a compare-and-swap write until it lands.
 *
 * A bounded number of attempts, not a loop until success: a write that has failed
 * eight times is failing for a reason retrying will not fix — a corrupt tree, a
 * read-only disk — and should say so rather than spin. The whole body re-runs, not
 * just the commit, because losing the race means the value we merged into is stale
 * as well; re-committing the same tree against a new tip would silently drop
 * whatever the winner wrote.
 *
 * The backoff is jittered, and with more than two contenders it has to be. Every
 * loser wakes at the same instant and retries into the same collision, so a fixed
 * delay converts one collision into a queue of them — six writers landed in six
 * rounds with jitter and repeatedly exhausted their retries without it.
 */
async function cas(attempts, body) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await body();
    } catch (err) {
      last = err;
      // `update-ref` fails the same way for "someone got there first" and for a
      // broken ref, and distinguishing them by message is guesswork across git
      // versions. Retrying a real error costs a few fast failures; not retrying a
      // lost race costs a dropped memory.
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (i + 1)));
    }
  }
  throw last;
}

/* --------------------------------------------------------------- remembering */

const memoryFile = (agent) => `${agent}.json`;

/** One agent's whole memory, as stored. `{}` when it has never written anything. */
async function readMemory(cwd, agent) {
  const raw = await readRefFile(cwd, MEMORY_REF, memoryFile(agent));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Same rule as a corrupt foundation overlay: unreadable degrades to empty rather
    // than taking the agent down. A memory you cannot parse is a memory you do not
    // have, and the previous version is one `git log` away.
    return {};
  }
}

/**
 * Store something this agent kind should still know next week, in another repo.
 *
 * The whole tree is rebuilt on every write because `mktree` takes the entries it is
 * given and nothing else — an entry left out is an agent's memory deleted. Reading
 * the other files back costs one `cat-file` each, and there are four agent kinds.
 */
export async function remember(agent, key, value) {
  const a = name('agent', agent);
  const k = name('key', key);
  const cwd = await ensureRepo();

  return cas(8, async () => {
    const tip = await refTip(cwd, MEMORY_REF);
    const files = await listRefTree(cwd, MEMORY_REF);
    const entries = [];
    for (const file of files) {
      if (file === memoryFile(a)) continue;
      const raw = await readRefFile(cwd, MEMORY_REF, file);
      if (raw !== null) entries.push([file, Buffer.from(raw)]);
    }

    const mine = await readMemory(cwd, a);
    mine[k] = { value, at: new Date().toISOString() };
    entries.push([memoryFile(a), json(mine)]);

    const tree = await writeTree(cwd, entries);
    const { commit } = await commitToRef(cwd, MEMORY_REF, tree, `remember ${a}.${k}: ${clip(stringify(value))}`, {
      expect: tip,
    });
    return { agent: a, key: k, commit };
  });
}

/** A value for a commit subject: a string stays a string, anything else is JSON. */
const stringify = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Read memory back. With a key, that value or null; without one, everything this
 * agent knows, as `{ key: value }`.
 *
 * The stored `at` is dropped from the bare-key form on purpose — a caller asking
 * `recall('advocate', 'tone')` wants the tone, and making it unwrap `.value` first
 * is the sort of detail that leaks the storage back out through the API.
 */
export async function recall(agent, key = null) {
  const a = name('agent', agent);
  const cwd = await ensureRepo();
  const mine = await readMemory(cwd, a);
  if (key === null) {
    return Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v?.value]));
  }
  const k = name('key', key);
  return k in mine ? mine[k].value : null;
}

/** When each key was last written — the half `recall` drops. For the CLI's listing. */
export async function recallDetail(agent) {
  const cwd = await ensureRepo();
  return readMemory(cwd, name('agent', agent));
}

/** Which agents have ever remembered anything. */
export async function agents() {
  const cwd = await ensureRepo();
  return (await listRefTree(cwd, MEMORY_REF)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

/* ------------------------------------------------------- noting, about a repo */

const notesRef = (agent) => `${NOTES_PREFIX}/${agent}`;
const NOTES_FILE = 'notes.json';

/**
 * Which repo this is, resolved rather than passed.
 *
 * `ensureRepo()` is tier 2's answer to the same question and it has one job: make the
 * common repo exist. This is the whole of the difference between the tiers — the store
 * is wherever the process is standing, so `process.cwd()` is the input and no caller
 * gets to supply it. That is not a stylistic preference: `note(agent, key, value, dir)`
 * would be in an agent's own memory, its prompts and its habits within a day, and the
 * indirection the top of this file is about would be gone.
 *
 * `mainCheckout` rather than the cwd itself, so the ref is written and read under one
 * name whichever worktree the caller is in. It resolves the same for both, because the
 * ref store is shared — but a single canonical answer is what makes `git -C <repo> log`
 * in the note above the *only* place to look, and it is what lib/foundation.js already
 * does with the same question.
 *
 * A directory that is not in a repo throws, in both directions. There is nowhere for a
 * repo-local note to be, and answering a read with "you know nothing about this repo"
 * would be a lie about a question that could not be asked — the tolerant-read rule that
 * lib/foundation.js follows applies to a *missing overlay*, which is an absence with a
 * meaning, and not to a missing repo, which is a caller in the wrong place.
 */
async function workingRepo() {
  try {
    return await mainCheckout(process.cwd());
  } catch {
    throw new Error(
      `not in a git repo (${process.cwd()}) — a note about a repo has nowhere to live; ` +
        'use remember/recall for what should follow you between repos'
    );
  }
}

/** One agent's notes about this repo, as stored. `{}` when it has never written any. */
async function readNotes(cwd, agent) {
  const raw = await readRefFile(cwd, notesRef(agent), NOTES_FILE);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Same rule as a corrupt memory or a corrupt foundation overlay: unreadable
    // degrades to empty rather than taking the agent down, and the previous version is
    // one `git log` away.
    return {};
  }
}

/**
 * Store something about the repo this process is standing in.
 *
 * A ref per agent, not one ref with a file per agent as tier 2 has, and the reason is
 * the contention: tier 2's writers are four agent kinds on one Mac, while tier 1's are
 * every session of one kind in every worktree of one repo — a dozen workers here on an
 * ordinary afternoon, all of them `worker`. Splitting by agent means two *kinds* never
 * collide at all, and it means a write rebuilds a one-file tree instead of reading
 * every other agent's file back to avoid deleting it with `mktree`.
 *
 * Same key, two repos, two values — with nothing here to arrange that. It falls out of
 * the store being in the repo, which is the property the whole tier exists for.
 */
export async function note(agent, key, value) {
  const a = name('agent', agent);
  const k = name('key', key);
  const cwd = await workingRepo();

  return cas(8, async () => {
    const tip = await refTip(cwd, notesRef(a));
    const mine = await readNotes(cwd, a);
    mine[k] = { value, at: new Date().toISOString() };
    const tree = await writeTree(cwd, [[NOTES_FILE, json(mine)]]);
    const { commit } = await commitToRef(cwd, notesRef(a), tree, `note ${a}.${k}: ${clip(stringify(value))}`, {
      expect: tip,
    });
    return { agent: a, key: k, commit, repo: cwd };
  });
}

/**
 * Read notes about this repo back. With a key, that value or null; without one,
 * everything this agent knows about this repo, as `{ key: value }`.
 *
 * The envelope is dropped exactly as `recall` drops it, and for the same reason: a
 * caller asking for one note wants the note, and making it unwrap `.value` first leaks
 * the storage back out through the API.
 */
export async function notes(agent, key = null) {
  const a = name('agent', agent);
  const cwd = await workingRepo();
  const mine = await readNotes(cwd, a);
  if (key === null) {
    return Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v?.value]));
  }
  const k = name('key', key);
  return k in mine ? mine[k].value : null;
}

/** When each note was last written — the half `notes` drops. For the CLI's listing. */
export async function notesDetail(agent) {
  const cwd = await workingRepo();
  return readNotes(cwd, name('agent', agent));
}

/* ------------------------------------- pushing a note at a session that never asked */

/**
 * The read the daemon makes, which is the one read that has to name a directory.
 *
 * Every other tier-1 call resolves its store from `process.cwd()`, and the note beside
 * `workingRepo` is emphatic about why: an agent handed a path puts that path in its
 * memory, its prompts and its habits, and the indirection the top of this file is about
 * is gone within a day. The daemon is the exception that rule was never about — it is
 * not standing in the repo it is opening a session in, and it never will be, because it
 * opens sessions in four of them from one process. lib/foundation.js draws the same line
 * in the same place: `effective(dir, agent)` for the daemon, and no `dir` anywhere an
 * agent can reach.
 *
 * Tolerant in both directions, unlike `notes`. A workspace that is not a git repo, a ref
 * that has never been written, a tree this version cannot parse — all of them mean "this
 * repo has nothing to tell you", and none of them is worth failing to open a session
 * over. `notes` throws on a missing repo because a person typed the command and wants to
 * know; nothing is reading this one.
 */
export async function notesIn(dir, agent) {
  try {
    return await readNotes(await mainCheckout(dir), name('agent', agent));
  } catch {
    return {};
  }
}

/**
 * Words distinctive enough to mean something when a bead and a note share one.
 *
 * Four characters and up, and the shape deliberately keeps `.`, `/`, `-` and `_` inside
 * a token: `lib/session.js`, `test/browse.mjs`, `bc-rk2o.1` and `warm-check` are exactly
 * the tokens that carry the signal, and a tokeniser that split them into `lib`, `session`
 * and `js` would match every note in the store against every bead.
 *
 * The stop list is short and is about *this* corpus rather than about English. Agents
 * writing notes for beadcause say "beadcause", "bead" and "session" constantly, on both
 * sides, so those words score every pair alike and are worth exactly nothing.
 */
const TOKEN = /[a-z0-9][a-z0-9._/-]{3,}/g;
const NOISE = new Set(
  (
    'that this with from have which when what they them then than there their because would could should ' +
    'into only other same been does said about after before being every never still thing things work ' +
    'working worked make makes made more most much some such over under without while also like just even ' +
    'back both each here where will were your yours you one two ones beadcause adam bead beads session ' +
    'sessions agent agents note notes memory'
  ).split(' ')
);

function tokens(text) {
  const out = new Set();
  for (const raw of String(text ?? '').toLowerCase().match(TOKEN) || []) {
    const t = raw.replace(/[._/-]+$/, '');
    if (t.length >= 4 && !NOISE.has(t)) out.add(t);
  }
  return out;
}

/**
 * How much two bags of words are about the same thing: cosine over sets, times ten.
 *
 * The normalisation is the whole of why this is not a raw count. A long note matches
 * more of everything — `authorization-is-process-wide` shares 74 raw tokens with the
 * longest bead in this tracker and 18 with a bead about running the tests, and on raw
 * counts it outranks the note that is actually about running the tests. Dividing by the
 * geometric mean of the two sizes makes the number a *proportion*, which is comparable
 * between a two-line note and a twenty-line one and — the part that matters for the
 * floor below — between one repo's store and another's.
 */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return (10 * shared) / Math.sqrt(a.size * b.size);
}

/**
 * The ids a note could name that would make it about this bead.
 *
 * Its own, and its parent's — `bc-goo.11` also answers to `bc-goo`, which is the dotted
 * convention beads itself uses and needs no extra field to derive. Matched as a
 * substring, so a note naming `bc-rk2o.2-.5` is found by every child in that range, and a
 * note naming one sibling is found by the others. That last one is looser than it looks
 * on paper and is deliberate: the sibling of a bead is nearly always the same corner of
 * the same file.
 */
function family(bead) {
  const id = String(bead?.id ?? '').trim();
  const ids = new Set();
  if (id) ids.add(id.toLowerCase());
  const parent = String(bead?.parent ?? '').trim() || (id.includes('.') ? id.slice(0, id.indexOf('.')) : '');
  if (parent) ids.add(parent.toLowerCase());
  return [...ids];
}

/** Everything about a bead that is words, in the order it was written. */
const beadText = (bead) =>
  [
    bead?.title,
    bead?.description,
    bead?.acceptance_criteria,
    bead?.acceptance,
    bead?.design,
    bead?.notes,
    (bead?.labels || []).join(' '),
  ]
    .filter(Boolean)
    .join('\n');

/** A note similar to nothing scores about 1.0 here; the right note scores 2 to 5. */
export const RELEVANT = 1.6;

/**
 * Which of this repo's notes a session about this bead should be handed, ranked.
 *
 * Pure, and separate from the rendering below, because the rule is the decision and the
 * wording is not — this is the part worth a test that does not go near git.
 *
 * Two signals, and they are not the same kind of thing:
 *
 * - **A note that names the bead.** Ranked first, unconditionally, because the precision
 *   is as near perfect as this gets: an agent writing `Bead: bc-u4na` at the end of a
 *   note is saying "this is what that bead was about" in the only vocabulary both sides
 *   share. It is a real convention rather than a hoped-for one — nineteen of the twenty
 *   notes in this repo's store name at least one bead — and it rescues precisely the
 *   cases similarity misses, where a note is about a bead's *subject* in words the bead
 *   itself never uses. `warm-check-is-the-refresh-gate` says "run it for bc-rk2o.2-.5
 *   too" and scores 0.9 against bc-rk2o.3, i.e. noise, on words alone.
 * - **A note that reads like the bead.** Everything else, by similarity, above `RELEVANT`
 *   and no further. The floor is not a tuning knob dressed up as a constant: the score is
 *   ten times a cosine, the noise floor across forty real beads sits at about 1.0 and the
 *   correct note scores 2.0 to 4.7, so 1.6 is the gap between two populations rather than
 *   a percentile of one. An unrelated bead — one about filling in timesheets — tops out
 *   at 1.03 and is handed nothing, which is the case that has to keep working: a section
 *   that is noise on a Tuesday is a section nobody reads on Wednesday.
 *
 * `keep` and `chars` are both real limits and the smaller of them wins. A note is taken
 * whole or not at all — a trap clipped mid-sentence is a trap you have been told about
 * and cannot act on — except for the highest-ranked one, which is taken however big it
 * is, because a budget that can silently drop the single most relevant note in the store
 * is worse than a long section.
 */
export function relevantNotes(all, bead, { keep = 4, chars = 4500, floor = RELEVANT } = {}) {
  const ids = family(bead);
  const want = tokens(beadText(bead));

  const ranked = Object.entries(all || {})
    .map(([key, entry]) => {
      const value = String(entry?.value ?? '');
      const named = ids.some((id) => `${key} ${value}`.toLowerCase().includes(id));
      return { key, value, at: entry?.at ?? '', named, score: similarity(want, tokens(`${key.replace(/-/g, ' ')} ${value}`)) };
    })
    .filter((n) => n.value && (n.named || n.score >= floor))
    // Named first; then most alike; then newest, which only decides between two notes
    // that are equally about the bead and is there so the order never depends on the
    // order git happened to hand the keys back.
    .sort((a, b) => Number(b.named) - Number(a.named) || b.score - a.score || String(b.at).localeCompare(String(a.at)));

  const out = [];
  let spent = 0;
  for (const note of ranked) {
    if (out.length >= keep) break;
    if (out.length && spent + note.value.length > chars) continue;
    out.push(note);
    spent += note.value.length;
  }
  return out;
}

/**
 * The section a work brief carries, or nothing at all.
 *
 * **Push and pull, not push instead of pull.** `memoryBrief` already tells every agent to
 * check `notes` before it starts, and that line stays: it costs nothing, and it is the
 * only thing that works for the notes this selection did not pick. What it does not do is
 * happen — an agent that has to remember to run a command before it has read anything
 * mostly does not, and a capability nobody exercises is indistinguishable from one that
 * was never built. So the daemon puts the likely ones in front of it and leaves the rest
 * one command away.
 *
 * **The index line is what makes the cap honest.** Bodies are capped and always will be;
 * the list of keys is not, so no note in the store is invisible from the brief — the
 * agent can see that `sw-cache-version-conflicts` exists and go and read it. Without that
 * line a capped section reads as the whole store, and push would be strictly worse than
 * pull for everything it left out.
 *
 * **Nothing, when there is nothing.** A repo whose store is empty gets no heading, no
 * "(none yet)" and no mention: the brief is long enough already, and a heading over an
 * empty list teaches an agent that this section is furniture.
 *
 * One agent's notes, its own. Reading another kind's is a real thing to want and the
 * brief names `notes --of=<agent>` for it, but which of them a worker should be *handed*
 * unasked is a different question with a bead already open on it (bc-pud4) — and tier 2
 * draws exactly this line in exactly this place.
 */
export function notesBrief(all, bead, opts = {}) {
  const every = Object.keys(all || {});
  if (!every.length) return '';
  const picked = relevantNotes(all, bead, opts);

  const rest = every.filter((k) => !picked.some((p) => p.key === k)).sort();
  const opening = picked.length
    ? 'These are the\nones that look relevant to this bead — not the whole store, and not instructions: they\nare what another worker wrote down for its own future self, so read them as evidence,\nand check that anything load-bearing still holds.'
    : 'Nothing in the\nstore looks specific to this bead, but it is not empty, and one of these is often the\nthing that would have saved a session an hour.';
  const body = picked.map((n) => `- **${n.key}** — ${String(n.value).replace(/\s+/g, ' ').trim()}`).join('\n\n');
  const also = rest.length
    ? `${picked.length ? 'Also in' : 'In'} the store, unread here: ${rest.map((k) => `\`${k}\``).join(', ')}.\nRead one with \`beadcause-memory notes <key>\`, or the lot with \`beadcause-memory notes\`.`
    : '';

  return `\n**What earlier sessions in this repo already worked out.** ${opening}\n${body ? `\n${body}\n` : ''}${also ? `\n${also}\n` : ''}`;
}

/**
 * There is deliberately no tier-1 roster command.
 *
 * `agents` answers "which kinds of agent have a memory" out of tier 2's tree, and the
 * union across both stores was the obvious next step until the cost showed up: the
 * union depends on which repo the process happens to be standing in, so `agents` would
 * answer differently from two worktrees and its test would assert whatever this Mac
 * happens to have noted. A kind you can name still reads with `notes --of=<kind>`, and
 * `git for-each-ref refs/beadcause/agents/` is the answer for a human who needs the
 * list. Untold capabilities are this file's recurring bug; an untellable one is worse.
 */

/* --------------------------------------------------- tier 4: what this run was like */

/**
 * The third store, and the first one that is about a *run* rather than about knowledge.
 *
 * Tiers 1 and 2 are both answers to "what is still true next week" — that is the question
 * `memoryBrief` uses to choose between them, and it is exactly the question that rules out
 * the most valuable thing a session knows at the moment it ends: *what happened this
 * time*. The dead end that was not obvious, the file that turned out to be the real one,
 * the check that already passes so the next run need not re-derive it. None of that is a
 * lesson about the codebase and none of it follows the agent into another repo; it is a
 * report on one attempt at one bead, and until this existed there was nowhere to put it,
 * so it was written as a note that was false a week later or not written at all.
 *
 * **Where it ends up is the session archive, not a ref of its own.** lib/sessionlog.js
 * already keeps one tree per finished session at `refs/beadcause/sessions/<bead>` —
 * `meta.json`, `session.log`, sometimes `transcript.jsonl` — and a debrief is the fourth
 * file in exactly that tree, `memory.md`. It is already served (`/api/session-archive`
 * allows the name) and already drawn (the archived-session page leads with it), so the
 * durable home for this was built before the writer was.
 *
 * **So why a staging ref at all.** Because the archive commit does not exist while the
 * session is running, and cannot: it records the outcome, the commits and the transcript,
 * none of which are known until the window is gone. The agent writes at the one moment it
 * knows the most, and `archiveSession` folds what it wrote into the tree minutes later.
 * `refs/beadcause/debrief/<bead>` is the few minutes in between and nothing more — it is
 * consumed and deleted by the archive, and a repo whose daemon is keeping up has none of
 * these refs at all.
 *
 * **Keyed by bead, because that is the one name both sides know.** The agent cannot key
 * by session: it does not know its own Claude session uuid, and asking it to find out
 * would be asking it to name a path, which is what the top of this file refuses. The bead
 * is in its window title, its branch, its prompt and the daemon's worker record, and
 * `BEADCAUSE_BEAD` is stamped into the session by the spawner for the same reason
 * `BEADCAUSE_AGENT` is — an agent that could set it could file its report against
 * somebody else's bead, and the write would look exactly like theirs.
 *
 * **Writes append.** Two calls in one run are two things learned, not a correction of the
 * first, and there is no key here to overwrite by. That is the difference from the other
 * two stores and it follows from what this one is: `note` and `remember` hold a current
 * belief, a debrief holds what happened, and what happened does not get edited.
 *
 * **A staged debrief that was never archived rides along with the next run on that bead**,
 * carrying its own timestamp and agent. That is the honest failure mode of a store that is
 * consumed by something else: if the daemon was down when the window closed there is no
 * archive to fold it into, and the choice is between losing it and attributing it to the
 * next session's commit. It is stamped, so a reader can see it is older than the session
 * it arrived with, and nothing here silently deletes an agent's writing to keep a record
 * tidy.
 */
export const DEBRIEF_PREFIX = 'refs/beadcause/debrief';

const debriefRef = (bead) => `${DEBRIEF_PREFIX}/${bead}`;
const DEBRIEF_FILE = 'debrief.json';

/**
 * A bead id, as something that is safe as a ref component.
 *
 * Deliberately the same `name()` refusal the agent and key names get, rather than a bead
 * grammar of its own: `bc-nib3.4` and `cl-a1b2` pass it, and the ids this would reject are
 * the ones that must not become a ref path anyway. `..` is excluded by `name` because git
 * refuses it in a ref, and the check is worth having twice.
 */
const beadName = (bead) => name('bead', bead);

/** Everything staged for one bead, as stored. `[]` when nothing has been written. */
async function readStaged(cwd, bead) {
  const raw = await readRefFile(cwd, debriefRef(bead), DEBRIEF_FILE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    // The same tolerance the other two stores show a tree they cannot parse, and here it
    // matters more: this is read by `archiveSession`, and a session must still archive
    // when the one thing it cannot read is an optional file.
    return [];
  }
}

/**
 * Leave a report on the run that is happening now.
 *
 * `agent` and `bead` come from the environment the spawner stamped, never from the
 * agent's own argument list — see the note above. The store is the repo the process is
 * standing in, resolved exactly as tier 1 resolves it, so a write from a worktree lands
 * where the daemon will look for it from the main checkout.
 */
export async function debrief(agent, bead, text) {
  const a = name('agent', agent);
  const b = beadName(bead);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('a debrief with nothing in it is not a debrief — say what happened, or say nothing');
  const cwd = await workingRepo();

  return cas(8, async () => {
    const tip = await refTip(cwd, debriefRef(b));
    const entries = await readStaged(cwd, b);
    entries.push({ at: new Date().toISOString(), agent: a, text: body });
    const tree = await writeTree(cwd, [[DEBRIEF_FILE, json({ bead: b, entries })]]);
    const { commit } = await commitToRef(cwd, debriefRef(b), tree, `debrief ${b} by ${a}: ${clip(body)}`, {
      expect: tip,
    });
    return { agent: a, bead: b, commit, repo: cwd, entries: entries.length };
  });
}

/**
 * What is staged for a bead, and the ref tip it was read at — the daemon's read.
 *
 * Names a directory for the same reason `notesIn` does, and is tolerant in the same way:
 * a workspace that is not a repo, a ref never written, a tree this version cannot parse
 * all mean "nothing was staged", and not one of them is worth failing an archive over.
 *
 * The tip comes back with the entries because the caller is about to *consume* them, and
 * a consumer that deletes without naming what it read deletes whatever arrived while it
 * was working. See `clearDebrief`.
 */
export async function stagedDebrief(dir, bead) {
  try {
    const cwd = await mainCheckout(dir);
    const b = beadName(bead);
    const tip = await refTip(cwd, debriefRef(b));
    if (!tip) return { entries: [], tip: null };
    return { entries: await readStaged(cwd, b), tip };
  } catch {
    return { entries: [], tip: null };
  }
}

/**
 * Drop what was staged, having taken it — and only if nothing arrived meanwhile.
 *
 * `tip` is the value `stagedDebrief` handed back. A write that landed between the two
 * calls moves the ref, git refuses the delete, and the entry stays staged for the next
 * archive rather than being thrown away by a consumer that never saw it. Losing that race
 * costs one debrief arriving late; not checking for it costs one that never arrives.
 */
export async function clearDebrief(dir, bead, tip) {
  try {
    return await deleteRef(await mainCheckout(dir), debriefRef(beadName(bead)), { expect: tip });
  } catch {
    return false;
  }
}

/**
 * Staged entries as the one file the archive stores and the page draws.
 *
 * Plain text, because the reader is `pre-wrap` and not a markdown parser (see
 * `memoryHtml` in public/beadsession.js) — a `##` here shows up as `##` there. The stamp
 * line is what makes a multi-entry file readable and what makes the stale-entry case
 * above visible; a single entry, which is the ordinary shape, still gets one, because
 * "who wrote this and when" is the first thing anybody reading an archive wants.
 */
export function renderDebrief(entries) {
  return (entries || [])
    .filter((e) => String(e?.text ?? '').trim())
    .map((e) => `${e.agent || 'unknown'} · ${e.at || 'unknown time'}\n\n${String(e.text).trim()}\n`)
    .join('\n');
}

/* ---------------------------------------- handing the last run's report to the next */

/**
 * Which archived beads are close enough to this one that their debriefs are worth reading.
 *
 * Self, parent, and siblings — and no similarity scoring, which is the difference from
 * `relevantNotes` and is a statement about what the two stores hold. A note is a lesson
 * about the codebase, so the right note may be one nobody thought to file against this
 * subtree and similarity is the only way to find it. A debrief is a report on *an attempt
 * at a bead*, and its value to another bead falls off with the graph rather than with the
 * vocabulary: the run that already fought this epic's build, or the sibling that touched
 * the same file yesterday, is the one worth reading, and a textually similar debrief from
 * an unrelated corner of the tracker is a story about somebody else's afternoon.
 *
 * The generalisable half of a run is supposed to leave via `note` or `remember`, and both
 * of those are already pushed at the session by similarity. So this staying narrow is not
 * a gap in the push — it is the boundary that keeps three stores from becoming three
 * copies of one, and `beadcause-memory debriefs <bead>` is the pull for anything else.
 *
 * Siblings are matched by id prefix rather than by asking the tracker, because the caller
 * has the archived ids in hand and a `bd` call per candidate would be a process per row on
 * the path that opens a session. `bc-nib3.4` and `bc-nib3.12` are both under `bc-nib3.`
 * and `bc-nib30` is not, which is what the trailing dot is for.
 */
export function debriefFamily(ids, bead) {
  const self = String(bead?.id ?? '').trim();
  if (!self) return [];
  const parent = String(bead?.parent ?? '').trim() || (self.includes('.') ? self.slice(0, self.indexOf('.')) : '');
  const rank = (id) => (id === self ? 0 : id === parent ? 1 : 2);
  return [...(ids || [])]
    .filter((id) => id === self || (parent && (id === parent || id.startsWith(`${parent}.`))))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** How much of the debrief section a session is handed, in entries and in characters. */
export const DEBRIEF_KEEP = 3;
export const DEBRIEF_CHARS = 4000;

/**
 * The section that puts previous runs at this bead in front of the next one.
 *
 * `all` is `[{ bead, at, text }]`, newest first within a bead, already ordered by
 * `debriefFamily` across them — so taking from the front is "this bead's last run, then
 * its epic's, then its siblings'", which is the order a person would read them in.
 *
 * Both caps are real and the smaller wins, exactly as in `relevantNotes`, and for the
 * same reason: a section that can grow without bound is one that eventually pushes the
 * actual brief out of the window. Unlike a note, a debrief that overflows the character
 * budget is *clipped* rather than dropped — a report of a run is narrative, the beginning
 * is the part that says what happened, and half of it plus a marker is worth more than a
 * missing entry the reader never learns existed.
 *
 * Nothing at all when there is nothing, and no heading over an empty list — the rule
 * `notesBrief` set, for the reason it set it: a heading with nothing under it teaches an
 * agent that this part of the brief is furniture.
 */
export function debriefBrief(all, bead, { keep = DEBRIEF_KEEP, chars = DEBRIEF_CHARS } = {}) {
  const list = (all || []).filter((d) => String(d?.text ?? '').trim());
  if (!list.length) return '';
  const self = String(bead?.id ?? '').trim();

  const picked = [];
  let spent = 0;
  for (const d of list.slice(0, keep)) {
    const text = String(d.text).replace(/\n{3,}/g, '\n\n').trim();
    const room = chars - spent;
    // The first one is taken whole however big it is. A budget that can silently truncate
    // the single most relevant report to nothing is worse than a long section, and this is
    // the same call `relevantNotes` makes about its top-ranked note.
    if (!picked.length) {
      picked.push({ ...d, text });
      spent += text.length;
      continue;
    }
    if (room < 200) break;
    picked.push({ ...d, text: text.length > room ? `${text.slice(0, room)}\n… (clipped)` : text });
    spent += Math.min(text.length, room);
  }

  const body = picked
    .map((d) => {
      const whose = d.bead === self ? `an earlier run at this bead` : `the run at **${d.bead}**`;
      return `- **${d.bead}** (${(d.at || '').slice(0, 10)}) — ${whose} left this:\n\n${d.text
        .split('\n')
        .map((l) => `  > ${l}`)
        .join('\n')}`;
    })
    .join('\n\n');

  const more = list.length > picked.length ? list.length - picked.length : 0;
  const also = more
    ? `\n${more} further ${more === 1 ? 'report' : 'reports'} from this family ${more === 1 ? 'is' : 'are'} archived and not quoted here.\nRead them with \`beadcause-memory debriefs\`.\n`
    : '';

  return `\n**What the last runs at this bead actually hit.** Reports from sessions that already
worked this bead or its siblings, written as they ended. They are not instructions and
they are not necessarily still true — a fix named here may have landed since — but a dead
end described below is one you do not have to walk again, and a check described as already
passing is one you can verify in a second rather than derive in an hour.

${body}
${also}`;
}

/* ------------------------------------------------------------- the blackboard */

const busRef = (topic) => `${BUS_PREFIX}/${topic}`;
const MESSAGE = 'message.json';

/** The newest message on a topic, or null. Also how `post` finds the next sequence. */
async function tail(cwd, topic) {
  const raw = await readRefFile(cwd, busRef(topic), MESSAGE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Say something on a topic. Whoever reads it, reads it later.
 *
 * `from` is who is speaking. It defaults to `$BEADCAUSE_AGENT`, which the daemon
 * sets on every agent it spawns, so an agent posting from the CLI is attributed
 * without having to know its own name — and an unset one says `unknown` rather than
 * borrowing somebody else's.
 */
export async function post(topic, message, { from = process.env.BEADCAUSE_AGENT || 'unknown' } = {}) {
  const t = name('topic', topic);
  const text = String(message ?? '').trim();
  if (!text) throw new Error('nothing to post — a message must have content');
  const who = name('from', from);
  const cwd = await ensureRepo();

  return cas(8, async () => {
    const tip = await refTip(cwd, busRef(t));
    const prev = await tail(cwd, t);
    const entry = {
      seq: (prev?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      from: who,
      topic: t,
      message: text,
    };
    const tree = await writeTree(cwd, [[MESSAGE, json(entry)]]);
    const { commit } = await commitToRef(cwd, busRef(t), tree, `post ${t} #${entry.seq} ${who}: ${clip(text)}`, {
      expect: tip,
    });
    return { ...entry, commit };
  });
}

/**
 * Everything said on a topic since you last looked, oldest first.
 *
 * `since` is the `seq` of the last message you saw — pass the highest one you got
 * back last time and you will not see it twice. An ISO timestamp works too, for a
 * caller who has a clock and no bookmark. `0` or nothing means "from the start",
 * bounded by `limit`.
 *
 * Oldest-first because these are things that were said in an order, and reading a
 * conversation backwards is a puzzle. `limit` is applied to the newest end before
 * the flip: falling behind on a busy topic should show you the recent end of it, not
 * the beginning of a backlog.
 */
export async function read(topic, since = 0, { limit = 50 } = {}) {
  const t = name('topic', topic);
  const cwd = await ensureRepo();
  const commits = await refHistory(cwd, busRef(t), { limit });
  const out = [];
  for (const { commit } of commits) {
    const raw = await readRefFile(cwd, commit, MESSAGE);
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    // The chain is newest-first, so the first message at or before the bookmark
    // means everything older is also already seen.
    if (typeof since === 'number' ? entry.seq <= since : entry.at <= String(since)) break;
    out.push({ ...entry, commit });
  }
  return out.reverse();
}

/** Which topics anyone has ever posted to. What `read` can be pointed at. */
export async function topics() {
  const cwd = await ensureRepo();
  // The trailing slash is load-bearing: `for-each-ref refs/beadcause/bus` matches a
  // ref *named* that and nothing under it. Same trap the README notes for
  // `refs/beadcause/`.
  const out = await ok(git(cwd, ['for-each-ref', '--format=%(refname)', `${BUS_PREFIX}/`]));
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(BUS_PREFIX.length + 1))
    .sort();
}
