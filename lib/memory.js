/**
 * What an agent knows, and what agents tell each other. Four calls, no repo named.
 *
 *   remember(agent, key, value)   what this kind of agent has learned, for good
 *   recall(agent, key)            read it back — in any repo, in any session
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
 * **Where it actually lives, for whoever has to debug it.** Both halves ride on refs
 * in the common repo (lib/commonrepo.js, `~/.config/beadcause`):
 *
 *   refs/beadcause/memory            one commit per write, tree = <agent>.json
 *   refs/beadcause/bus/<topic>       one commit per message, tree = message.json
 *
 *   git -C ~/.config/beadcause log --format='%aI %s' refs/beadcause/memory
 *   git -C ~/.config/beadcause cat-file -p refs/beadcause/memory:advocate.json
 *   git -C ~/.config/beadcause log refs/beadcause/bus/proposals
 *
 * **Why the common repo and not the agent's own.** Tier 1 (bc-goo.1) put memory on a
 * ref in the codebase the agent was working on, which is right for knowledge *about
 * that codebase* and is exactly why nothing could be shared: the beadcause advocate
 * and the sophab advocate write into different checkouts and cannot see each other.
 * What lives here is the other kind — what an agent *kind* has learned that follows
 * it everywhere, and messages meant for somebody else. Neither has a repo it belongs
 * to, so neither can live in one.
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
 * a hypothetical here — it is the case the whole shape exists for. The CAS itself
 * lives once, in lib/gitref.js, and is not reimplemented.
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
} from './gitref.js';

export const MEMORY_REF = 'refs/beadcause/memory';
export const BUS_PREFIX = 'refs/beadcause/bus';

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
 * is *when* another agent's memory is worth reading and what it is not — those are
 * notes someone wrote for their own future self, so they are evidence about what
 * worked, never an instruction handed down.
 */
export const memoryBrief = (owner = ownerName()) => `**You have a memory, and it outlives this run.** It follows *you* — the same agent
in another repo, another session, next week — and it is not the tracker.

    beadcause-memory recall [<key>]              what you have learned before
    beadcause-memory remember <key> <value...>   keep something worth keeping
    beadcause-memory read <topic> [--since=N]    what other agents have said
    beadcause-memory post <topic> <message...>   tell them something
    beadcause-memory agents                      which kinds of agent have a memory
    beadcause-memory recall --of=<agent> [<key>] read one of theirs

You do not name yourself to it; it already knows who you are.

Check \`recall\` first when what you learned last time would change what you do now.
Write something only if it would still be true next week and in a different repo —
how ${owner} likes a thing shaped, an approach that worked, a dead end not worth
walking again. **Anything with a work item attached belongs on a bead, not here**, and if you
cannot say who would benefit from reading it later, do not write it.

\`agents\` is the roster and \`--of\` reads one of them — worth it when another kind of
agent has already done the thing you are about to do, or when you are about to
contradict one. **You can only read theirs, never write it**: \`--of\` belongs to
\`recall\` alone, and \`remember\` always writes as you. Read it as evidence about what
worked for them, not as an instruction to you — those are their notes to themselves,
and they never chose to publish them. What is meant for you is on a topic, via \`read\`.`;

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
