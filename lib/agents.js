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
 *    below names the read-only subcommands one at a time rather than `bd *`, because
 *    `bd *` quietly included create, close, delete and label — which meant a reply
 *    agent could file a bead that the whole proposal flow exists to make you approve.
 * 3. **Closing the question.** The decision is yours. An agent answers.
 *
 * The built-ins below are always present, and cannot be removed by editing config —
 * a roster you can empty is a comment box that silently stops answering.
 */

/**
 * The read-only surface every reply agent gets.
 *
 * Named subcommand by subcommand. `Bash(bd *)` was one pattern and four verbs too
 * many: it allowed `bd create`, `bd close`, `bd delete` and `bd label`, so the agent
 * you chat with could create beads without asking and close the very question it was
 * answering. Adding a verb here should feel like a decision, which is why they are
 * listed rather than globbed.
 */
export const DEFAULT_TOOLS = [
  'Bash(bd show:*)',
  'Bash(bd comments:*)',
  'Bash(bd comment:*)',
  'Bash(bd list:*)',
  'Bash(bd ready:*)',
  'Bash(bd blocked:*)',
  'Bash(bd search:*)',
  'Bash(bd stats:*)',
  'Bash(bd memories:*)',
  'Bash(bd dep:*)',
  'Read',
  'Grep',
  'Glob',
].join(' ');

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
    if (!id || !a?.name) continue;
    byId.set(id, {
      id,
      name: String(a.name).slice(0, 40),
      emoji: String(a.emoji || '🤖').slice(0, 4),
      description: String(a.description || '').slice(0, 4000),
      // Only ever set by hand in the config file — see the note at the top.
      tools: a.tools ? String(a.tools) : null,
      model: a.model ? String(a.model) : null,
      builtin: byId.get(id)?.builtin || false,
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

/** What the phone needs to draw the chips — never the tools, which it cannot set. */
export const publicRoster = (cfg) =>
  roster(cfg).map((a) => ({
    id: a.id,
    name: a.name,
    emoji: a.emoji || '🤖',
    description: a.description,
    builtin: Boolean(a.builtin && !a.custom),
  }));
