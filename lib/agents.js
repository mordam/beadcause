import { baseline, mark } from './foundation.js';

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
 * The read-only surface every reply agent gets — re-exported, not defined here.
 *
 * The list lives in lib/toolbelt.js, and it lives there for a load-order reason
 * rather than a tidiness one. lib/foundation.js records the same list as the dispatch
 * agent's baseline, this module imports `baseline` and `mark` back from it, and while
 * the list was defined *here* that pair was a cycle whose evaluation order decided
 * whether it loaded at all: reach lib/agents.js first and it died on `Cannot access
 * 'DEFAULT_TOOL_LIST' before initialization` (bc-u4na). A third module both sides
 * import has no order to get wrong. The whole argument — including why one copy read
 * from two places beats two copies — is at the top of lib/toolbelt.js.
 *
 * Re-exported rather than moved out of sight, because this is still where a reader
 * looks for it: what a reply agent may run is part of the roster, and importing
 * either name from lib/agents.js is correct.
 */
export { DEFAULT_TOOL_LIST, DEFAULT_TOOLS } from './toolbelt.js';

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
 *
 * **Two rosters, and the kinds are the one that actually owns conversations.** The
 * list above is the reply personas — who answers a comment on a bead — and the ids
 * `POST /api/console` accepts are the *agent kinds* in lib/foundation.js: the
 * advocate, the dispatcher, the work session. So every agent chat there has ever
 * been resolved to nothing here and drew as a fallback 🤖 with its bare id (bc-rjes).
 * `mark` is where a kind's name and emoji live now, and it is consulted first: an id
 * that is a kind *is* that kind, whatever a config agent of the same name would like
 * to be called, because a persona cannot own one of these records in the first place.
 */
export function withAgentNames(consoles, cfg) {
  const list = roster(cfg);
  return consoles.map((c) => {
    const id = c.agent || 'console';
    // The chat session itself. It has no agent to name — it *is* the baseline the
    // rest are being told apart from.
    if (id === 'console') return c;
    const kind = mark(id);
    if (kind) return { ...c, agentName: kind.name, agentEmoji: kind.emoji };
    const a = list.find((x) => x.id === id);
    return { ...c, agentName: a?.name || id, agentEmoji: a?.emoji || '🤖' };
  });
}
