import YAML from 'yaml';
import {
  AMENDABLE,
  PROTECTED,
  baseline,
  commitOwner,
  displayName,
  effective,
  declined as priorDeclines,
  amend,
  decline,
} from './foundation.js';
import { normalizeBead } from './proposal.js';
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
 *
 * **And an argument this loop cannot settle is still an argument.** `AMENDABLE` is
 * eight fields; an agent can conclude things about itself that are none of them — a
 * PROTECTED field, the brief it was handed this run, a denial that came from some other
 * module's code. Those are still rejected *as amendments*, and rejected whole: nothing
 * here half-applies a request. What they no longer do is disappear. `parseAmendment`
 * names the offending fields in `beyond` and keeps the scope, the justification and the
 * evidence, and `beyondAmendment` turns all of that into an ordinary proposed bead
 * against the file a commit would have to touch — which rides the same approve/decline
 * card every other proposal rides, so still nothing exists until Adam says so. The
 * agent has one channel more; it has no more power than it had.
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
 *
 * One kind of wrong comes back *fully populated as well as errored*: a block asking for
 * a field outside `AMENDABLE` carries `beyond: [field, …]` beside its `error`. Every
 * existing caller keys off `error` and so still refuses to apply it — that is the
 * property that must not bend — but the scope and the argument survive the parse, so
 * `beyondAmendment` can carry them somewhere a commit can happen. The two bars run
 * *before* that, deliberately: a request with no scope, or a justification that is a
 * phrase, is unanswerable in either channel and should die here rather than be filed
 * somewhere new.
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
  // Named, never applied. Half-applying a request applies something Adam did not
  // approve — he approved the whole of what he read — so a block that names one of
  // these is refused entire, exactly as `foundation.validate` refuses it. What is new
  // is that the field names are carried out of here instead of being the last thing
  // anyone knew about the request: see `beyondAmendment`.
  const beyond = [];
  for (const [k, v] of Object.entries(spec.set || {})) {
    if (!AMENDABLE.includes(k)) beyond.push(k);
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

  const request = {
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

  if (beyond.length) {
    // Errored *and* complete. The error is what stops every caller applying it; the
    // rest is what lets one of them file a bead instead of a log line.
    return {
      ...request,
      beyond,
      error: `not amendable: ${beyond.join(', ')} (amendable: ${AMENDABLE.join(', ')})`,
    };
  }
  return request;
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

/* --------------------------------------------- what only a commit can give it */

/** Long enough to judge, short enough to be a bead and not a transcript. */
const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
};

/**
 * Whatever the agent wrote, made safe to nest inside a fenced block.
 *
 * This text ends up inside the ` ```beadproposal ` fence in `proposalBody`, and a model
 * that quoted code in its justification would otherwise close that fence three lines
 * early — the card truncates and `parseProposal` reads half a bead. Changing three
 * backticks is a smaller lie than losing the rest of the sentence.
 */
const unfence = (s) => String(s ?? '').replace(/```/g, "'''");

/** `a`, or `a` and `b`, or `a`, `b` and `c`. */
const andList = (xs) =>
  xs.map((x) => `\`${x}\``).reduce((acc, x, i) => (i === 0 ? x : i === xs.length - 1 ? `${acc} and ${x}` : `${acc}, ${x}`), '');

const quoted = (s) =>
  unfence(s)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

/**
 * The request an amendment may not grant, as a bead someone can act on.
 *
 * The three cases this exists for are all real and all used to end at a log line: a
 * PROTECTED field (`writes`, `protocolOwner`, `id`), which only a release can change; the
 * brief the agent was handed this run, which is deliberately not amendable because an
 * agent that could rewrite its own brief could decide it had been asked something else;
 * and a field name that is nothing in the foundation at all, which is what "the thing
 * that stopped me is in some other module" comes out as when an agent has only this
 * block to say it in.
 *
 * Returned as a **proposed** bead, not a filed one, and that is the whole safety story:
 * it goes into the same `beadproposal` card as everything else an advocate suggests, so
 * it is still Adam who creates it, still one tap to decline, and an agent arguing about
 * itself has gained no ability to put anything in the tracker. Built through
 * `normalizeBead` so it is indistinguishable in shape from a bead the model wrote.
 *
 * Nothing here is fenced. A ` ``` ` inside this text would end the block that carries it.
 *
 * `null` for a request that is not one of these, which callers already treat as "no
 * extra bead". A card is a thing Adam has to read, and a bead with no field named on it
 * is worse than the log line this replaced.
 */
export function beyondAmendment(request, foundation, { workspace = '', from = '' } = {}) {
  const fields = request?.beyond || [];
  if (!fields.length) return null;
  const name = (foundation?.title || displayName(request.agent)).replace(/^the /i, '');
  const locked = fields.filter((f) => PROTECTED.includes(f));
  const owners = [...new Set(fields.map((f) => commitOwner(f, foundation)))];

  const parts = [];
  parts.push(
    `The **${name}** asked to change ${andList(fields)}, and beadcause did not apply it: an ` +
      `amendment may only set ${AMENDABLE.join(', ')}. Nothing about the agent changed, and ` +
      `nothing here changes it either — this bead is the argument it made, kept because a ` +
      `change only a commit can make is exactly what a bead is for.`
  );

  parts.push(
    `**What it asked for**\n\n${changeLines(request, foundation)
      .map((c) => `- **${c.field}** — ${clip(unfence(c.summary).replace(/\n/g, ' '), 300)}`)
      .join('\n')}`
  );
  parts.push(`**Scoped to:** ${clip(unfence(request.scope), 300)}`);
  parts.push(`**Why — in its own words**\n\n${quoted(clip(request.justification, 1500))}`);
  parts.push(KIND_LABEL[request.kind] || '');
  if (request.evidence) parts.push(`**What actually happened**\n\n${quoted(clip(request.evidence, 1200))}`);

  parts.push(
    `**Where a change would have to be made**\n\n${fields
      .map(
        (f) =>
          `- \`${f}\` → \`${commitOwner(f, foundation)}\` — ${
            PROTECTED.includes(f)
              ? 'protected there on purpose: the fields whose wrongness is invisible at approval time, so changing one costs a commit and a deploy'
              : 'not a foundation field, so this is the module that composes the brief it was handed. A starting point rather than a certainty'
          }`
      )
      .join('\n')}`
  );

  // The advocate for another repo files into *that* repo's tracker, because that is
  // where it runs and where its foundation is stored. Its own definition is not there.
  // Saying so is the difference between an actionable bead and one that sends whoever
  // picks it up looking for a file that does not exist in the checkout they are in.
  if (workspace) {
    parts.push(
      `Those paths are in the **beadcause** checkout. This is filed in ${workspace} because ` +
        `that is the repo the ${name} runs in and files into — the code that defines it is ` +
        `beadcause's own.`
    );
  }

  parts.push(
    `If the answer is no, the reason is worth putting where the agent will see it — its ` +
      `memory, or the next foundation refusal it is shown — and not only on this bead. A ` +
      `closed bead is invisible to it, so it will reason its way back here.`
  );

  return normalizeBead({
    title: locked.length
      ? `Should the ${name}'s ${fields.join(', ')} change? It asked, and only a commit can`
      : `The ${name} asks for ${fields.join(', ')} — a change in ${owners.join(', ')}, not an amendment`,
    // A protected field is a decision Adam already made once, deliberately, and this is
    // an argument for revisiting it. Anything else is ordinary work with a name attached.
    type: locked.length ? 'decision' : 'task',
    // Below the work an advocate finds in the repo, on purpose. An agent's opinion about
    // itself is worth hearing and is not worth outranking a bug someone can point at.
    priority: 3,
    description: parts.filter(Boolean).join('\n\n'),
    acceptance:
      `Either ${owners.join(' / ')} changes so the ${name} has this, or the bead is closed with the ` +
      `reason it should not — written where the agent will see it, not only here.`,
    rationale:
      `Written by beadcause, not by the agent: the ${name} put this in an amendment block` +
      `${from ? ` after ${from}` : ''}, where it cannot be applied. Filing it is the only thing ` +
      `that keeps the reasoning; the words quoted above are its own.`,
  });
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
 *
 * `propose` says whether this agent has a `beadproposal` block of its own — the advocate
 * does, a reply agent does not — because that decides where a request *outside* the
 * amendable set should go, and pointing an agent at a block it has not been given is
 * worse than not mentioning the other channel at all. Both wordings end somewhere Adam
 * reads; only one of them ends in a bead.
 */
export function reflectionPrompt(foundation, refusals = [], owner = ownerName(), { propose = false } = {}) {
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
- **One request.** If two things are missing, ask for the one that mattered today.

### If what you want is not one of those fields

**Only these are amendable:** ${AMENDABLE.join(', ')}. That is the whole of what the
block above can change, and an amendment naming anything else is not applied — not
because nobody agrees with you, but because approving it would change nothing.

Three things you might genuinely want are outside it:

- **\`writes\`, \`protocolOwner\`, \`id\`.** Locked to a release on purpose. Whether you may
  write to the tracker is the review step itself, and an agent that could grant itself
  that would make the whole review a formality. It is in \`lib/foundation.js\`.
- **The brief you were handed for this run** — everything above this section: what you
  were asked, what you were told to look at, what counts as done. Deliberately not
  amendable, because an agent that could rewrite its own brief could decide it had been
  asked something else. It is composed in \`${foundation.briefOwner || '(the module that spawns you)'}\`.
- **Anything else in the code.** "What stopped me was not my allowlist, it was that
  function" is a real thing to have found, and it is not a field.

${
  propose
    ? `Those belong in your ordinary \`beadproposal\` block, as a bead like any other:
against the file that owns the thing, saying what should change and why. Same bar as
every other proposal — specific, and obvious to ${owner} in one sentence — and it rides
the same approve/decline card, which is the point: ${owner} can *act* on a bead, and
cannot act on an amendment they are not allowed to apply. You have run this survey
before and will run it again, and "the instructions I am given are wrong about X" is the
most valuable thing you can say. Say it there.

If you put one in the amendment block anyway, your reasoning is not thrown away —
beadcause proposes it as a bead for ${owner}, quoting you. But the block is still the
wrong channel, and you only get one request.`
    : `Say those in your comment on the bead instead. That is what ${owner} actually
reads, and a paragraph naming the file and the problem is something they can act on —
which an amendment they are not allowed to apply is not. Put one in the block above and
it can only be logged and dropped; say it in the comment and it is in front of them.`
}`;
}

/* ------------------------------------------------------------- filing it */

/**
 * The agent's currently open question about itself, if it has one.
 *
 * One open self-request at a time, whichever channel it would go down. Two
 * constitutional questions in an inbox is how the channel starts reading as noise, and
 * the second would be written without the answer to the first — which is exactly the
 * argument the agent should be waiting for. It gates the amendment card in
 * `fileRequest` and the proposed bead in lib/advocate.js, deliberately as one rule and
 * not two: "ask again through the other door" is the loophole a per-channel rule leaves.
 *
 * `known: false` means the tracker could not be read, which is treated as "hold back"
 * everywhere. Saying nothing costs one survey's request; asking twice costs the channel.
 */
export async function openSelfAsk(bd, workspace) {
  try {
    const open = await bd.listLabel(workspace, AMENDMENT_LABEL);
    return { known: true, id: open.length ? open[0].id : null };
  } catch {
    return { known: false, id: null };
  }
}

/**
 * Turn a parsed request into the question Adam sees.
 *
 * `null` when there is nothing to file, which covers three cases worth keeping
 * separate in the log: no block at all, a block we rejected, and a request that is
 * already open or has already been refused. Only the middle one is a problem.
 */
export async function fileRequest(bd, workspace, dir, request, { from = '' } = {}) {
  const foundation = await effective(dir, request.agent);

  const open = await openSelfAsk(bd, workspace);
  if (!open.known) return null; // Cannot tell. Better to say nothing than to ask twice.
  if (open.id) {
    return { skipped: `${open.id} is already open`, id: null };
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
