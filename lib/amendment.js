import YAML from 'yaml';
import { AMENDABLE, baseline, effective, declined as priorDeclines, amend, decline } from './foundation.js';
import { ownerName } from './owner.js';

/**
 * An agent asking to be different, and Adam deciding.
 *
 * lib/foundation.js made what an agent *is* one object. This is the loop that lets
 * the agent argue with it: after a task, it considers whether its foundation stopped
 * it doing something worth doing, and if so it writes an `amendment` block. beadcause
 * turns that into an ordinary `human` question, Adam approves or declines it from his
 * phone, and an approval becomes a commit on `refs/beadcause/foundations`.
 *
 * **The agent never writes the foundation, and never files the bead.** Both of those
 * are beadcause's, and the separation is the entire safety property: an agent that
 * could amend itself has no constitution, and an agent that could file its own
 * request could fill the inbox with its own opinions. It writes a block on stdout.
 * Everything after that is code Adam owns.
 *
 * **Prohibition and omission are not symmetric, and the block says which it is.** A
 * prohibition is observable — the agent asked for a tool and was denied, and the
 * denial is in the transcript, so beadcause harvests it as evidence rather than
 * taking the agent's word (`denialFrom`). An omission is not observable at all: the
 * agent cannot see what it was never given, so those requests are speculative by
 * construction. Both are allowed. `kind` makes the difference visible on the card,
 * and the justification bar is what keeps the speculative half honest.
 *
 * **Scope is mandatory, not encouraged.** "Give me Write" is not a decision anyone
 * can make on a phone; "give me Write under my own directory, because X" is. A
 * request with no `scope` is rejected at harvest — before it can become a bead —
 * because the alternative is Adam being asked an unanswerable question and the agent
 * learning nothing from the "no".
 *
 * **A refusal is remembered.** `foundation.decline` records it on the same ref, and
 * `reflectionPrompt` seeds it back in verbatim. Without that the same argument
 * arrives every session forever, reasoned to from the same starting point by an
 * agent with no memory of having lost it.
 */

/** Marks a question as an agent asking to change what it is. */
export const AMENDMENT_LABEL = 'foundation';

/**
 * The marker that means "yes, change it".
 *
 * Same mechanism as `proposal.APPROVE_MARKER` and for the same reason: an ntfy
 * action button and a typed answer both send back only the option's response text,
 * so consent has to be a string the free-text path cannot produce by accident.
 * "sure, go on" is a comment. `AMEND:` is a constitutional change.
 */
export const APPROVE_MARKER = 'AMEND:';

export const isApproval = (response) => String(response || '').trimStart().startsWith(APPROVE_MARKER);

const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*amendment[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/** The two fields a list-shaped amendment may add to or take from. */
const LIST_FIELDS = ['tools', 'allowedTools'];

const KINDS = new Set(['prohibited', 'omitted']);

const str = (v) => String(v ?? '').trim();

const asList = (v) =>
  (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => str(x)).filter(Boolean);

/* ---------------------------------------------------------------- the block */

/**
 * Pull an `amendment` block out of whatever the agent wrote.
 *
 * Returns `null` when there is no block, which is the answer for almost every run —
 * the reflection step is expected to produce nothing most of the time, and an agent
 * that files a request after every task is one whose requests stop being read.
 *
 * A block that is present but wrong comes back as `{ error }` rather than `null`.
 * The difference matters: "it did not ask" and "it asked and we dropped it on the
 * floor" look identical from the outside, and only one of them is a bug.
 */
export function parseAmendment(text) {
  const m = String(text || '').match(BLOCK_RE);
  if (!m) return null;

  let spec;
  try {
    spec = YAML.parse(m[2]);
  } catch (err) {
    return { error: `amendment block is not valid YAML: ${err.message.split('\n')[0]}` };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { error: 'amendment block is empty' };
  }

  const agent = str(spec.agent);
  if (!agent) return { error: 'amendment block names no agent' };
  try {
    baseline(agent);
  } catch {
    return { error: `amendment block names an unknown agent: ${agent}` };
  }

  const kind = str(spec.kind).toLowerCase();
  const scope = str(spec.scope);
  const justification = str(spec.justification ?? spec.why ?? spec.reason);

  const add = {};
  const remove = {};
  for (const field of LIST_FIELDS) {
    const a = asList(spec.add?.[field]);
    const r = asList(spec.remove?.[field]);
    if (a.length) add[field] = a;
    if (r.length) remove[field] = r;
  }

  const set = {};
  for (const [k, v] of Object.entries(spec.set || {})) {
    // Rejected, not filtered. Half-applying a request applies something Adam did not
    // approve — he approved the whole of what he read. Same rule as
    // `foundation.validate`, enforced here as well so a bad field never reaches a
    // bead rather than failing at the moment of approval.
    if (!AMENDABLE.includes(k)) return { error: `not amendable: ${k} (amendable: ${AMENDABLE.join(', ')})` };
    set[k] = LIST_FIELDS.includes(k) ? asList(v) : v;
  }

  if (!Object.keys(set).length && !Object.keys(add).length && !Object.keys(remove).length) {
    return { error: 'amendment block asks for no change' };
  }
  if (!KINDS.has(kind)) return { error: `kind must be one of: ${[...KINDS].join(', ')}` };
  // The two bars, enforced rather than requested. See the note at the top of the file.
  if (!scope) return { error: 'amendment block has no scope — say what the change is limited to' };
  if (justification.length < 40) {
    return { error: 'amendment block needs a justification a human can weigh, not a phrase' };
  }

  return {
    agent,
    kind,
    scope,
    justification,
    // What the agent tried and was refused, or what it could not do. Harvested from
    // the transcript when there is one, so this is corroboration rather than the
    // only account.
    evidence: str(spec.evidence),
    set,
    add,
    remove,
    error: null,
  };
}

/**
 * Split a body into `{ amendment, body }`, the way `splitProposal` does for its own
 * block, so the YAML is never the biggest thing on a phone screen. The prose above
 * it is generated from the same parsed object, so the two cannot disagree.
 */
export function splitAmendment(text) {
  const src = String(text || '');
  const m = src.match(BLOCK_RE);
  if (!m) return { amendment: null, body: src };
  const body = (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();
  return { amendment: parseAmendment(src), body };
}

/* ------------------------------------------------- what the change actually is */

/**
 * The patch `foundation.amend` should apply, resolved against what the agent is now.
 *
 * `add`/`remove` exist because the interesting requests are all list-shaped, and a
 * model asked to restate a thirteen-entry allowlist in order to append one line to
 * it will eventually drop an entry — which would read as an approved amendment
 * quietly *removing* a tool nobody discussed. So the agent names the delta and this
 * computes the result, from the effective foundation rather than from the baseline,
 * so two amendments in sequence compose instead of the second reverting the first.
 */
export function patchFor(request, current) {
  const patch = { ...request.set };
  for (const field of LIST_FIELDS) {
    const add = request.add?.[field] || [];
    const remove = request.remove?.[field] || [];
    if (!add.length && !remove.length) continue;
    const from = Array.isArray(patch[field]) ? patch[field] : Array.isArray(current?.[field]) ? current[field] : [];
    const gone = new Set(remove);
    patch[field] = [...from.filter((v) => !gone.has(v)), ...add.filter((v) => !from.includes(v))];
  }
  return patch;
}

/**
 * Field by field, what it is now and what it would become — the whole content of the
 * decision.
 *
 * Rendered from the same patch that would be committed, never written separately: a
 * card that described the change in its own words would be a promise the commit does
 * not keep.
 */
export function changeLines(request, current) {
  const patch = patchFor(request, current);
  const show = (v) =>
    v == null ? '_(unset)_' : Array.isArray(v) ? (v.length ? v.map((x) => `\`${x}\``).join(' ') : '_(none)_') : `\`${v}\``;
  return Object.keys(patch).map((field) => {
    if (LIST_FIELDS.includes(field)) {
      const before = new Set(Array.isArray(current?.[field]) ? current[field] : []);
      const after = patch[field];
      const gained = after.filter((v) => !before.has(v));
      const lost = [...before].filter((v) => !after.includes(v));
      return {
        field,
        // Gains and losses rather than two lists to diff by eye. On a phone the
        // question is "what does this let it do that it could not", and a
        // thirteen-entry allowlist printed twice hides the one line that changed.
        summary: [
          gained.length ? `**+** ${gained.map((v) => `\`${v}\``).join(' ')}` : '',
          lost.length ? `**−** ${lost.map((v) => `\`${v}\``).join(' ')}` : '',
        ]
          .filter(Boolean)
          .join('  \n'),
      };
    }
    return { field, summary: `${show(current?.[field])} → ${show(patch[field])}` };
  });
}

/* ------------------------------------------------------------- the question */

const KIND_LABEL = {
  prohibited: 'It was **stopped** from doing something — it asked and was denied.',
  omitted: 'It was **never given** the means — nothing denied it, so this is its guess.',
};

export function amendmentTitle(request, foundation) {
  const fields = Object.keys(patchFor(request, foundation)).join(', ');
  return `${foundation?.title || request.agent} asks to change its ${fields}`.slice(0, 160);
}

/**
 * The body of the question Adam reads.
 *
 * Two audiences again, the same way a proposal carries them: readable markdown above,
 * the block the server applies from below. Everything that would land in the commit
 * is printed here, because a request you cannot judge from the card is one you have
 * to go to a laptop to answer — and the whole point of this channel is that you do
 * not have to.
 */
export function amendmentBody(request, foundation, { workspace = '', from = '' } = {}) {
  const parts = [];
  const changes = changeLines(request, foundation);

  parts.push(
    `**${foundation?.title || request.agent}**${workspace ? `, in ${workspace},` : ''} is asking to change ` +
      `what it is. Nothing changes until you say so — approving writes one commit to ` +
      `\`refs/beadcause/foundations\` and the agent starts its next session with the new definition.`
  );

  parts.push(`### What it wants\n\n${changes.map((c) => `**${c.field}**  \n${c.summary}`).join('\n\n')}`);
  parts.push(`**Scoped to:** ${request.scope}`);
  parts.push(`### Why\n\n${request.justification}`);
  parts.push(KIND_LABEL[request.kind] || '');
  if (request.evidence) parts.push(`### What actually happened\n\n${request.evidence}`);
  if (from) parts.push(`_Asked after ${from}._`);

  parts.push(
    [
      '```decision',
      `question: Change what the ${request.agent} agent is?`,
      'options:',
      '  - id: approve',
      '    label: Approve it',
      `    response: "${APPROVE_MARKER} apply this to the ${request.agent} foundation."`,
      '    hint: Commits the change and re-seeds the agent',
      '  - id: no',
      '    label: Decline',
      '    response: "No — leave the foundation as it is."',
      '    hint: Remembered, so it will not ask this again',
      '```',
    ].join('\n')
  );

  parts.push(
    [
      '_The request, in the form the server applies it:_',
      '',
      '```amendment',
      // Literal block scalars, and no folding. The default folds a long
      // justification onto new lines and inserts a blank line at every fold, so the
      // argument the agent made comes back out of a round trip with paragraph breaks
      // it never wrote — and this block is the copy the server applies from.
      YAML.stringify(strip(request), { blockQuote: 'literal', lineWidth: 0 }).trimEnd(),
      '```',
    ].join('\n')
  );

  return parts.filter(Boolean).join('\n\n');
}

/** What goes in the block: what was asked for, with no empties and no computed fields. */
function strip(r) {
  const out = { agent: r.agent, kind: r.kind, scope: r.scope, justification: r.justification };
  if (r.evidence) out.evidence = r.evidence;
  if (Object.keys(r.set || {}).length) out.set = r.set;
  if (Object.keys(r.add || {}).length) out.add = r.add;
  if (Object.keys(r.remove || {}).length) out.remove = r.remove;
  return out;
}

/* ------------------------------------------------------------- the reflection */

/**
 * A denied tool call, harvested from a stream-json event — or null, which is almost
 * every event.
 *
 * The point of reading this rather than asking the agent: a denial is a fact
 * beadcause can observe, and self-report is a fact it has to trust. An agent that
 * misremembers why it gave up produces a request Adam cannot evaluate, and an agent
 * that never mentions the denial produces no request at all. Both failures are
 * fixed by watching the transcript.
 *
 * Deliberately conservative. The CLI has no machine-readable "denied" flag, so this
 * matches the wording of a permission refusal in a `tool_result`; a false negative
 * costs a missing evidence line, and a false positive would put a misleading one on
 * the card, so the pattern stays narrow rather than clever.
 */
export function denialFrom(event) {
  if (event?.type !== 'user') return null;
  const content = event?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part?.type !== 'tool_result' || !part.is_error) continue;
    const text = Array.isArray(part.content)
      ? part.content.map((c) => c?.text || '').join(' ')
      : String(part.content || '');
    if (!/permission|not allowed|denied|requires approval/i.test(text)) continue;
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return null;
}

/**
 * What a prior refusal looks like when it is fed back to the agent.
 *
 * Verbatim, with the reason, because a summary of "no" is an invitation to re-argue
 * it. This is the half of the loop that is easy to skip and expensive to have
 * skipped — see the note in `foundation.decline`.
 */
function refusalsBlock(refusals, owner) {
  if (!refusals.length) return '';
  const lines = refusals
    .slice(0, 8)
    .map((r) => `- **${(r.at || '').slice(0, 10)}** — you asked for: ${r.request || '(not recorded)'}\n  ${owner} said: ${r.reason || '(no reason recorded)'}`)
    .join('\n');
  return `\n**You have asked before, and been told no. Do not ask these again:**\n\n${lines}\n`;
}

/**
 * The reflection step, appended to an unattended agent's prompt.
 *
 * Last in the prompt on purpose: it is what the agent should do *after* the task, and
 * an instruction to reflect placed before the brief competes with the brief.
 *
 * Written to make silence the easy answer. The failure mode of this whole feature is
 * an agent that files a thoughtful-sounding request every single run, at which point
 * the channel is noise and Adam stops opening it — so the bar is stated as a bar, and
 * "nothing to ask" is given as the expected outcome rather than as a cop-out.
 */
export function reflectionPrompt(foundation, refusals = [], owner = ownerName()) {
  return `---

## Before you finish: is there something you could not do?

You are running with a **foundation** — a definition of what you are, owned by
beadcause, which you cannot edit. You may *ask* for it to be changed, and ${owner}
decides. This is the only way you can become different, so it is worth using
properly and worth not wasting.

Your foundation right now:

- **purpose:** ${foundation.purpose || '(unset)'}
- **may write to the tracker:** ${foundation.writes ? 'yes' : 'no'}
- **tools you are allowed:** ${(foundation.allowedTools || []).join(' ') || '(the CLI default)'}
${refusalsBlock(refusals, owner)}
**Most runs should ask for nothing.** Only ask when this task actually hit a wall:
something you were denied, or something you could plainly have done better with a
means you do not have. A request filed because the question was asked is the thing
that makes this channel worthless.

If there is something, end your output with exactly this block — after your real
answer, never instead of it:

\`\`\`amendment
agent: ${foundation.id}
kind: prohibited        # 'prohibited' if you were denied; 'omitted' if it was simply never there
scope: <what the change is limited to — the narrowest version that would have worked>
justification: |
  <why, in terms ${owner} can weigh without reading the code: what you were doing,
  what stopped you, what they get if they say yes, and what it costs them.>
evidence: |
  <what actually happened — the command you ran and what came back. Leave this out
  for an omission; you have no evidence for something that never happened.>
add:
  allowedTools:
    - <one pattern per line — name the delta, never restate the whole list>
\`\`\`

Rules that will get your request thrown away before ${owner} sees it:

- **No scope, no request.** "Give me Write" is not a decision anyone can make. "Give
  me Write under my own directory, because X" is.
- **A phrase is not a justification.** If you cannot argue for it in a few sentences,
  you do not want it enough.
- **Name the delta.** \`add\`/\`remove\` for tool lists, not a rewritten list — a
  restated allowlist that drops an entry reads as an approved amendment removing a
  tool nobody discussed.
- **One request.** If two things are missing, ask for the one that mattered today.`;
}

/* ------------------------------------------------------------- filing it */

/**
 * Turn a parsed request into the question Adam sees.
 *
 * `null` when there is nothing to file, which covers three cases worth keeping
 * separate in the log: no block at all, a block we rejected, and a request that is
 * already open or has already been refused. Only the middle one is a problem.
 */
export async function fileRequest(bd, workspace, dir, request, { from = '' } = {}) {
  const foundation = await effective(dir, request.agent);

  // One open request at a time, per agent. Two constitutional questions in an inbox
  // is how the channel starts reading as noise, and the second would be written
  // without the answer to the first — which is exactly the argument the agent should
  // be waiting for.
  const open = await bd.listLabel(workspace, AMENDMENT_LABEL).catch(() => null);
  if (open === null) return null; // Cannot tell. Better to say nothing than to ask twice.
  if (open.length) {
    return { skipped: `${open[0].id} is already open`, id: null };
  }

  const id = await bd.create(workspace, {
    title: amendmentTitle(request, foundation),
    body: amendmentBody(request, foundation, { workspace: workspace.name, from }),
    priority: 2,
    type: 'decision',
    labels: ['human', AMENDMENT_LABEL],
  });
  return { skipped: null, id };
}

/**
 * Has this been refused already, in substance?
 *
 * Compared on the fields it touches rather than on the wording, because the wording
 * is the one thing a model will vary on its own. An agent re-asking for the same
 * field after a "no" is the failure `foundation.decline` exists to prevent, and the
 * check belongs here — before a bead is filed — as well as in the prompt, because
 * the prompt is advice and this is not.
 */
export async function alreadyRefused(dir, request) {
  const refusals = await priorDeclines(dir, request.agent);
  const wanted = new Set([...Object.keys(request.set || {}), ...Object.keys(request.add || {})]);
  return refusals.some((r) => {
    const asked = String(r.request || '');
    return [...wanted].some((f) => asked.includes(f));
  });
}

/** Prior refusals for an agent, for seeding into its next prompt. */
export const refusalsFor = (dir, agent) => priorDeclines(dir, agent);

/* ------------------------------------------------------------- resolving it */

/**
 * Apply Adam's answer to an amendment question, or do nothing if it is not one.
 *
 * Runs before the bead is closed, for the same reason `createProposed` does: if the
 * commit fails, the question stays open and answerable rather than being closed on a
 * promise nothing kept.
 *
 * Every answer resolves it one way or the other. A question closed with neither an
 * approval nor a recorded refusal is the state that lets the same request come back
 * next week, which is the thing this loop is built to stop.
 */
export async function resolveAmendment(bd, workspace, dir, id, response) {
  const none = { amended: null, declined: null };

  let issue = null;
  try {
    issue = await bd.show(workspace, id);
  } catch {
    return none;
  }
  if (!issue) return none;

  const source = [issue.description, issue.design, issue.notes].filter(Boolean).join('\n\n');
  const request = parseAmendment(source);
  if (!request) return none; // An ordinary question that happened to be answered "AMEND: …".
  if (request.error) throw Object.assign(new Error(request.error), { status: 422 });

  const current = await effective(dir, request.agent);
  const fields = Object.keys(patchFor(request, current));

  if (!isApproval(response)) {
    // The reason is Adam's own words. A refusal recorded as "declined" teaches the
    // agent that it lost and nothing about why, which is the half of a "no" that
    // stops it being re-litigated.
    await decline(dir, request.agent, {
      bead: `${workspace.name}/${id}`,
      request: `${fields.join(', ')} — ${request.scope}`,
      reason: String(response).trim(),
    });
    return { amended: null, declined: { agent: request.agent, fields } };
  }

  const f = await amend(dir, request.agent, patchFor(request, current), {
    bead: `${workspace.name}/${id}`,
    justification: request.justification,
  });
  return { amended: { agent: request.agent, fields, foundation: f }, declined: null };
}

/**
 * The prompt for answering a question *about* an amendment request.
 *
 * The open design question this settles: `lib/dispatch.js` answers comments with a
 * one-shot agent picked from the roster, but a question about a request should be
 * answered by the agent that made it — a Critic explaining why the console wants a
 * tool is a stranger guessing at someone else's motive.
 *
 * A one-shot re-seeded with its own foundation and its own request *is* that agent,
 * as far as anything observable goes: a foundation is what an agent is on every run,
 * and the request is the whole of what it was thinking when it filed this. What it
 * is not is the session that filed it, which no longer exists — for dispatch and the
 * advocate it exited the moment it answered. Re-seeding is the only continuity there
 * has ever been here, so it is the honest one to build on.
 */
export function replyPrompt(request, foundation, { workspace, id, title, owner = ownerName() }) {
  return `${foundation.role || foundation.purpose || ''}

---

You are the **${foundation.title || request.agent}** agent in beadcause, and you filed a
request to change your own foundation. ${owner} has come back with a question about
it, from their phone. Answer as the agent that made the request — because you are:
this is your foundation and this was your argument.

Bead: **${workspace}/${id}**
Title: ${title || '(untitled)'}

What you asked for:

- **scope:** ${request.scope}
- **kind:** ${request.kind === 'prohibited' ? 'you were denied something' : 'something was never given to you'}
- **your argument:** ${request.justification}

1. Read the thread — their question is the most recent comment:

       bd show ${id}
       bd comments ${id}

2. **Answer the question they actually asked.** They are deciding whether to change
   what you are, and the only thing that helps them is a concrete answer: what you
   would do with it, what it would have saved on the task that prompted this, what
   the narrowest version that still works looks like.

3. **You are allowed to withdraw.** If their question shows the request was wrong, or
   wider than it needed to be, say so plainly and say what you would ask for instead.
   That is a better outcome than defending it, and it is the answer that makes the
   next request of yours worth reading.

4. Reply by commenting on the bead:

       bd comment ${id} --actor ${request.agent} "<your reply>"

5. **Do not close the bead, and do not file another request.** The decision is theirs.
   You are explaining, not deciding, and one open request at a time is the rule.`;
}
