import { baseline } from './foundation.js';

/**
 * Who you are talking to.
 *
 * Commenting on a bead has always dispatched an agent to reply (lib/dispatch.js),
 * and there was exactly one of it: a single prompt, hard-coded, whose whole
 * personality was "do what the comment asks". That is the right default and a poor
 * only option — half the time what a question needs is not an answer but a
 * counter-argument, or the three file paths that settle it, or the thread boiled
 * down to the one decision left in it. Those are different briefs, not different
 * phrasings of the same one.
 *
 * So an agent here is a **name and a foundation** — a paragraph that goes in front
 * of the standard thread instructions and sets what this one is for. Everything
 * else is shared: the same read-only allowlist, the same "comment, never close"
 * rule, the same streaming log.
 *
 * Three things are deliberately *not* per-agent, because they are the safety of the
 * feature rather than its point:
 *
 * 1. **Tools.** Every agent gets `DEFAULT_TOOLS` unless a `tools` string is written
 *    into the config file by hand. An agent you can create from your phone can never
 *    grant itself more reach than the one before it — a form on a lock screen is the
 *    wrong place to hand out edit rights.
 * 2. **Creating beads.** Nothing dispatched here can run `bd create`. The allowlist
 *    in lib/foundation.js names the read-only subcommands one at a time rather than
 *    `bd *`, because `bd *` quietly included create, close, delete and label — which
 *    meant a reply agent could file a bead the proposal flow exists to make you approve.
 * 3. **Closing the question.** The decision is yours. An agent answers.
 *
 * What every agent here *can* now do is look something up — see the lookup entries on
 * the list below. That is a read, in all three of its shapes, and it is still true
 * that nothing dispatched from a phone can write anywhere but its own memory.
 *
 * The built-ins below are always present, and cannot be removed by editing config —
 * a roster you can empty is a comment box that silently stops answering.
 */

/**
 * The read-only surface every reply agent gets.
 *
 * The list itself lives in lib/foundation.js, with the note on why each `bd` verb is
 * named one at a time instead of globbed. It is quoted from there rather than
 * repeated here because it is the dispatch agent's *foundation* — the thing an
 * approved amendment lands on — and two copies of an allowlist is one copy that gets
 * widened without the other noticing.
 *
 * The baseline, not the effective foundation: this is a module-level constant and
 * resolving an amendment is a git read. It is the fallback the dispatcher uses when
 * the effective one cannot be read, and the string the phone is shown.
 */
export const DEFAULT_TOOL_LIST = [
  'Bash(bd show:*)',
  'Bash(bd comments:*)',
  'Bash(bd comment:*)',
  'Bash(bd list:*)',
  'Bash(bd ready:*)',
  'Bash(bd blocked:*)',
  'Bash(bd search:*)',
  'Bash(bd stats:*)',
  'Bash(bd memories:*)',
  // `bd dep tree`, not `bd dep:*` (bc-1f99). `dep` is not a read: it carries `add`,
  // `remove`, `relate` and `unrelate`, and `bd dep <id> --blocks <id>` is a fifth
  // spelling of `add` on the bare verb — so the glob one level up let a comment
  // answered from a phone rewire the dependency graph, which is the arrangement the
  // rest of this list was expanded verb-by-verb to get off. Same shape of hole
  // bc-ec6 closed on the advocate, one agent down; that agent and the chat session
  // already name `tree` and nothing wider. If a reply agent ever wants the flat
  // `bd dep list`, that is an amendment to ask for, not a glob to take.
  'Bash(bd dep tree:*)',
  // The one write on this list, and it writes nowhere near the tracker: an agent's
  // own memory and the blackboard it shares with the others (lib/memory.js). It is
  // here rather than behind an elevation because the alternative is an agent that
  // can be told something and cannot keep it — the whole of what Tier 2 is for.
  'Bash(beadcause-memory:*)',
  'Read',
  'Grep',
  'Glob',
  // Looking something up, in the three shapes it takes — added deliberately (bc-awr),
  // because an agent that answers "I cannot look things up" to a question turning on
  // one external fact has given a true answer and a useless one.
  //
  // `WebSearch` and `WebFetch` are the preferable grant and are read-only by
  // construction: an agent can pull a page and cite it and cannot POST anywhere.
  // `beadcause-get` is the wrapper for what WebFetch mangles on its way to prose —
  // JSON, CSV, a raw table. It is here instead of `Bash(curl:*)` because that pattern
  // matches `-X POST`, `-d`, `--upload-file` and `-o` writing anywhere on disk, and
  // because curl reads `file://`. See lib/lookup.js for the whole argument; the short
  // version is that the agent may name a URL and may not name a method.
  'WebSearch',
  'WebFetch',
  'Bash(beadcause-get:*)',
];

/**
 * The same list as one space-separated string, which is the shape `--allowedTools`
 * wants. Derived rather than written twice — and the array is the source, because
 * several entries contain a space (`Bash(bd show:*)`), so the string cannot be split
 * back apart on whitespace. lib/foundation.js records this as the dispatch agent's
 * baseline and needs the array form.
 */
export const DEFAULT_TOOLS = DEFAULT_TOOL_LIST.join(' ');

/**
 * The roster you start with.
 *
 * Four, because four is the most that fits a phone's chip row without scrolling, and
 * because these are the four shapes a comment on a decision actually takes: answer
 * it, find the evidence, argue the other side, or tell me what this thread is even
 * asking any more.
 */
export const BUILTIN_AGENTS = [
  {
    id: 'answerer',
    name: 'Answerer',
    emoji: '💬',
    builtin: true,
    description: `You answer the question, plainly and completely. Do the thing the comment asks
rather than acknowledging it: if it asks for links, find the real paths in this repo
and give them; if it asks what you think, say what you think and why. A reply that
only restates the question is a wasted round trip.`,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    emoji: '🔍',
    builtin: true,
    description: `You are the one who goes and looks. Answer from evidence in this repo, not from
what is plausible: read the files, quote the lines that matter, and give the real
paths so they can be opened from the phone. Say plainly when the evidence is absent
or contradicts the premise of the question — that is the most valuable thing you can
report, and the one thing a confident guess would have buried.`,
  },
  {
    id: 'critic',
    name: 'Critic',
    emoji: '🧨',
    builtin: true,
    description: `You argue the strongest case against whatever is being proposed here. Not
scepticism as a pose — find the specific way it goes wrong: the case it does not
handle, the assumption it rests on, the thing it makes harder later. If, having
looked, the proposal is simply sound, say so in one line and give the single
condition under which it would stop being sound. A critic who cannot be satisfied is
noise.`,
  },
  {
    id: 'summariser',
    name: 'Summariser',
    emoji: '📋',
    builtin: true,
    description: `You take a thread that has gone on too long and hand back the decision that is
actually left in it. Lead with the question still open, then what has already been
settled, then what is blocking it. No recap of who said what. If the thread has in
fact resolved and nobody noticed, say that and quote the line where it happened.`,
  },
];

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

/**
 * Built-ins first, then yours.
 *
 * A configured agent whose id collides with a built-in **replaces** it, which is how
 * you re-word the Answerer without losing the ability to fall back to it by deleting
 * your version.
 */
export function roster(cfg) {
  const custom = Array.isArray(cfg?.agents) ? cfg.agents : [];
  const byId = new Map();
  for (const a of BUILTIN_AGENTS) byId.set(a.id, a);
  for (const a of custom) {
    const id = a?.id ? slug(a.id) : slug(a?.name);
    // A name is required for a NEW agent and pointless for an override: `{ id:
    // "critic", tools: "…" }` is the whole of what giving the Critic extra reach
    // should take, and demanding its name and description again invites the two
    // copies to drift.
    const base = byId.get(id);
    if (!id || (!a?.name && !base)) continue;
    byId.set(id, {
      id,
      name: String(a.name || base?.name || id).slice(0, 40),
      emoji: String(a.emoji || base?.emoji || '🤖').slice(0, 4),
      description: String(a.description || base?.description || '').slice(0, 4000),
      // Config file only — see the note at the top. The app can turn this ON for one
      // reply; it can never write it.
      tools: a.tools ? String(a.tools) : null,
      model: a.model ? String(a.model) : base?.model || null,
      builtin: Boolean(base?.builtin),
      custom: true,
    });
  }
  return [...byId.values()];
}

/** The agent an id names, or the configured default, or the first one there is. */
export function agentFor(cfg, id) {
  const list = roster(cfg);
  return (
    list.find((a) => a.id === id) ||
    list.find((a) => a.id === (cfg?.defaultAgent || 'answerer')) ||
    list[0]
  );
}

/**
 * Add one, from a name and a foundation. Returns the stored record.
 *
 * Rejects an id that already exists rather than silently replacing it: on a phone
 * the difference between "added" and "overwrote the one you use every day" has to be
 * something you were told about.
 */
export function addAgent(cfg, { name, description, emoji }) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('an agent needs a name'), { status: 400 });
  const text = String(description || '').trim();
  if (text.length < 20) {
    throw Object.assign(new Error('give it a foundation — a sentence or two on what this agent is for'), {
      status: 400,
    });
  }
  const id = slug(clean);
  if (!id) throw Object.assign(new Error('that name has no letters or digits in it'), { status: 400 });
  if (roster(cfg).some((a) => a.id === id)) {
    throw Object.assign(new Error(`there is already an agent called ${clean}`), { status: 409 });
  }

  const record = { id, name: clean.slice(0, 40), emoji: String(emoji || '🤖').slice(0, 4), description: text.slice(0, 4000) };
  cfg.agents = [...(Array.isArray(cfg.agents) ? cfg.agents : []), record];
  return record;
}

/** Remove one of yours. Built-ins are not removable — see the note at the top. */
export function removeAgent(cfg, id) {
  const target = slug(id);
  if (BUILTIN_AGENTS.some((a) => a.id === target) && !(cfg.agents || []).some((a) => slug(a.id || a.name) === target)) {
    throw Object.assign(new Error('that one is built in'), { status: 400 });
  }
  const before = (cfg.agents || []).length;
  cfg.agents = (cfg.agents || []).filter((a) => slug(a.id || a.name) !== target);
  if (cfg.agents.length === before) throw Object.assign(new Error(`no agent called ${id}`), { status: 404 });
  return target;
}

/**
 * Has this agent's extended-tools warning been shown and accepted before?
 *
 * Per agent, not once globally: the whole content of the warning is *what this
 * particular agent may now do*, and a blanket "yes I read it in March" would make
 * the second agent's elevation silent — which is the one thing the dialog exists to
 * prevent.
 */
export const acknowledged = (cfg, id) => (cfg?.agentToolsAcknowledged || []).includes(id);

export function acknowledge(cfg, id) {
  if (acknowledged(cfg, id)) return false;
  cfg.agentToolsAcknowledged = [...(cfg.agentToolsAcknowledged || []), id];
  return true;
}

/**
 * What the phone needs to draw the chips.
 *
 * `tools` IS sent — the string is the whole content of the consent dialog, and a
 * warning that will not tell you what is being granted is theatre. Sending it does
 * not make it settable: there is no endpoint that accepts one.
 */
export const publicRoster = (cfg, { armed = new Set(), busy = new Map() } = {}) =>
  roster(cfg).map((a) => ({
    id: a.id,
    name: a.name,
    emoji: a.emoji || '🤖',
    description: a.description,
    builtin: Boolean(a.builtin && !a.custom),
    // Null unless a `tools` string was written into the config for this agent.
    tools: a.tools || null,
    acknowledged: acknowledged(cfg, a.id),
    // Armed for exactly one reply — see lib/server.js. Never persisted: a daemon
    // restart is a disarm, and so is sending the comment.
    armed: armed.has(a.id),
    // The bead it is answering right now, if any. You cannot change what an agent
    // may do while it is doing it.
    busyOn: busy.get(a.id) || null,
  }));

/**
 * Say who is on the other end of each conversation.
 *
 * `listConsoles` knows an agent *id* — the launcher needs a name and an emoji to
 * draw with, and the roster is the only place those live, because a custom agent's
 * emoji is whatever its config says. Resolved here rather than on the phone so the
 * list arrives ready to render: a second fetch for the roster would paint every
 * agent chat as an ordinary chat session first and then correct itself.
 *
 * Deliberately not `agentFor`: that one falls back to the default agent, which
 * would label a conversation with a since-deleted agent as the Answerer. An id with
 * nothing behind it keeps its own name and the generic 🤖 — the conversation
 * happened, whatever the config says now.
 */
export function withAgentNames(consoles, cfg) {
  const list = roster(cfg);
  return consoles.map((c) => {
    const id = c.agent || 'console';
    // The chat session itself. It has no agent to name — it *is* the baseline the
    // rest are being told apart from.
    if (id === 'console') return c;
    const a = list.find((x) => x.id === id);
    return { ...c, agentName: a?.name || id, agentEmoji: a?.emoji || '🤖' };
  });
}
