/**
 * The P0 advocate — one agent per owned P0, and everything it knows written on the bead.
 *
 * bc-jk4m made the epic worker a planner and a supervisor: it decides which children
 * should exist, groups them for child-workers, writes their prompts, and argues them
 * through approval, merge and release. This file re-keys that from *an epic* to *a P0*
 * and gives it a name and a row in the roster — `epic-advocate`, a fifth kind in
 * lib/foundation.js's BASELINES rather than a mode of the per-repo advocate.
 *
 * **Why a fifth kind and not a mode.** The two answer different questions and the
 * difference is in their permissions, not their code path. lib/advocate.js is `writes:
 * false` on a deliberate argument — it may not invent work, because it is arguing about
 * a queue nobody has agreed to. This one is `writes: true`, because a P0 somebody *owns*
 * has already been agreed to and decomposing it is what planning is. A mode would have
 * had to carry both permissions and pick between them at runtime, which is the shape
 * where a bug grants the wider one. A kind also gets what a mode cannot: a foundation
 * you can amend, its own row on the agents screen, and its own mark — so "which advocate
 * said this" is answerable from a pill rather than by opening the conversation.
 *
 * **It is re-entrant, and that is a constraint rather than a detail.** bc-jk4m already
 * argues that a supervisor holding a worker slot for the life of an epic is both
 * expensive and reaped by `workerTimeoutMinutes`. So this agent is opened on child
 * events, does one turn of thinking, writes down what it concluded, and exits. Which
 * means **everything it knows has to be on the P0 bead**: the plan (lib/plan.js already
 * writes one, in a comment, and `readPlan` reads it back), and the one sentence this file
 * adds — what the P0 is waiting on.
 *
 * That sentence is not decoration. A P0 that has not moved in a week and a P0 quietly
 * progressing are identical from outside, and the inbox card bc-rfnr.2 draws has a slot
 * for exactly this. It is stored the way lib/superseded.js stores its own fingerprint —
 * an HTML comment marker in the notes — because notes survive a claim, a reopen and a
 * sync, and because a label cannot hold a sentence.
 */
import { ERROR_LABEL } from './errors.js';
import { isP0, ownerOf } from './ownership.js';
import { REQS_OPEN, REQS_CLOSE, candidateId, readRequirements } from './beadreqs.js';
import { gleanSection } from './reqglean.js';

/** The kind, as lib/foundation.js keys it. One spelling, because agent ids are on disk. */
export const EPIC_ADVOCATE = 'epic-advocate';

/**
 * Where the advocate writes what its P0 is waiting on, and how it finds it again.
 *
 * A marked block in `notes` rather than a field, for lib/plan.js's reason: bd has no
 * field for it, and the two candidates that exist are both worse. `design` is the
 * author's, and a `human` label would put the P0 in the inbox as a question — which it
 * is not; it is a status line under a card.
 */
export const WAITING_OPEN = '<!-- beadcause:waiting -->';
export const WAITING_CLOSE = '<!-- /beadcause:waiting -->';

/** How much of a sentence the card can draw. Two lines on a four-inch screen. */
export const WAITING_MAX = 160;

/** The block, as it goes into `notes`. Empty text erases it rather than writing a hollow one. */
export function waitingBlock(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, WAITING_MAX);
  return line ? `${WAITING_OPEN}\n${line}\n${WAITING_CLOSE}` : '';
}

/**
 * What this P0 is waiting on, off the row the sweep already has. `null` when nothing
 * has said.
 *
 * Null rather than a cheerful default, because the card draws nothing where this is null
 * and a placeholder would be a claim: "not waiting on anything" is a thing only an
 * advocate that has looked can say, and until one has, the honest card is one line
 * shorter.
 */
export function waitingOn(issue) {
  const notes = String(issue?.notes || '');
  const from = notes.indexOf(WAITING_OPEN);
  if (from < 0) return null;
  const to = notes.indexOf(WAITING_CLOSE, from);
  const body = (to < 0 ? notes.slice(from + WAITING_OPEN.length) : notes.slice(from + WAITING_OPEN.length, to))
    .replace(/\s+/g, ' ')
    .trim();
  return body || null;
}

/**
 * Should this P0 have an advocate of its own?
 *
 * Three noes, and each is a bead this agent would be wrong about rather than a case it
 * cannot handle:
 *
 * - **It is not a P0, or nobody owns it.** An advocate is answerable *to* somebody; one
 *   opened on an unowned P0 has nobody to report to and would be planning work the
 *   user has not agreed to carry. An unowned P0 is bc-rfnr.5's to fix, not this one's.
 * - **It is closed.** Nothing left to plan, and the same argument lib/stillopen.js makes
 *   at the launcher door: the planner's last act is to reopen its epic so the queue can
 *   see the plan, so one opened on a P0 that closed mid-survey would resurrect it.
 * - **It is a crash.** lib/errors.js files every daemon crash at P0 by construction, and
 *   a stack trace is not an epic. It gets an owner and a place at the top of the board —
 *   which is the point, the thing that just broke is the first thing on the screen — and
 *   it stays a leaf that is workable directly. A planning agent spun up for a stack
 *   trace is the failure bc-rfnr.4 exists to prevent.
 *
 * `isCrash` reads `app-error`, the label lib/errors.js puts on every bead it files —
 * a marker that already exists and is already the answer to "did the app file this
 * itself", rather than a second one meaning the same thing. Injectable so a test can
 * drive the branch without building an error bead, but the default is the real check
 * and the daemon never overrides it.
 */
export const isCrash = (issue) => (issue?.labels || []).some((l) => String(l).trim() === ERROR_LABEL);

export function wantsAdvocate(issue, { crash = isCrash } = {}) {
  if (!isP0(issue)) return false;
  if (String(issue?.status || '').toLowerCase() === 'closed') return false;
  if (!ownerOf(issue)) return false;
  return !crash(issue);
}

/**
 * What this P0 says about requirements, and what it is asked for — bc-fvmx's half of the brief.
 *
 * Three things, and the order is the argument.
 *
 * **What it already says.** Ids first, because an advocate that cannot see what it wrote
 * last time rewrites it, and a block that is rewritten every run is a block whose history
 * means nothing.
 *
 * **What it wrote that does not exist.** `dropped` — ids that were in the block and are
 * not in the corpus. Named out loud rather than silently discarded, because an advocate
 * that is not told writes the same invented id every run, forever, and from outside that
 * is indistinguishable from the feature not working. This is the one line that stops the
 * loop.
 *
 * **The vocabulary.** The tokens that exist, so a candidate is filed under a real product
 * rather than one made up on the spot — the same closed-set discipline lib/requirements.js
 * applies to ids, applied one level up.
 *
 * And the refusal that matters most: **an empty answer must be cheap.** Most P0s in a
 * personal tracker fulfil no Climative requirement, an agent that feels it owes an answer
 * invents one, and one invented id beside a real one is a graph nobody can trust. So the
 * brief says so in as many words, twice, and asks for the block to be left off entirely
 * rather than filled with something plausible.
 */
export function requirementsSection(p0, corpus = null, { pending = [] } = {}) {
  const known = Boolean(corpus?.ids?.size);
  if (!known && !pending.length) return '';
  const { ids, candidates, dropped } = readRequirements(p0, corpus);

  const lines = ['', '**Requirements — what this P0 fulfils.**'];
  if (ids.length) {
    lines.push(
      '',
      'It already names these, and they resolve against the corpus:',
      '',
      ...ids.map((id) => {
        const entry = corpus?.ids?.get(id);
        return `- \`${id}\`${entry?.definition ? ` — ${entry.definition.slice(0, 160)}` : ''}`;
      })
    );
  }
  if (candidates.length) {
    lines.push(
      '',
      'And these **candidates**, which are proposals and not ids until a human approves them:',
      '',
      ...candidates.map((c) => `- \`${candidateId(c)}\` — ${c.definition}`)
    );
  }
  if (dropped.length) {
    lines.push(
      '',
      `**${dropped.map((d) => `\`${d}\``).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} written on this bead and ${dropped.length === 1 ? 'does' : 'do'} not exist.**`,
      'No requirement by that name is in the corpus, so it has been dropped rather than',
      'recorded — an id that does not resolve is a typo or an invention, and a graph with one',
      'in it cannot be told from a graph without. Either use the real id or file it as a',
      'candidate; do not write it back unchanged.'
    );
  }
  if (!ids.length && !candidates.length && !dropped.length) {
    lines.push('', 'It names none, which for most beads is correct and is not something to fix.');
  }

  if (known) {
    lines.push(
      '',
      `The tokens that exist are: ${corpus.tokens.join(', ')}. An id is \`TOKEN.Feature.Thing\` and`,
      'must already be in the corpus. **You may not mint one** — a requirement exists when it is',
      'written into the architecture repo, which forty people clone, and that is a proposal a',
      'human approves. What you can write is a candidate: a token that exists, a short name, and',
      'one testable definition sentence.',
      '',
      'If this P0 changes what one of those requirements means, or is the work that implements',
      'it, say so here — replacing any block already present:',
      '',
      '```',
      REQS_OPEN,
      '```json',
      '{ "ids": ["EN.Feature.Thing"], "candidates": [{ "token": "EN", "name": "Feature.Thing", "definition": "As a …, I want …" }] }',
      '```',
      REQS_CLOSE,
      '```',
      '',
      '**Leave it out entirely if nothing applies.** Most work in this repo is about this repo,',
      'and an empty answer costs nothing. A requirement invented to fill the space is worse than',
      'no answer at all, because the next reader will assume you had a reason.'
    );
  }

  const glean = gleanSection(pending, corpus?.tokens || []);
  return `${lines.join('\n')}${glean ? `\n${glean}` : ''}\n`;
}

/**
 * The brief, for one invocation.
 *
 * The *role* — what a P0 advocate is, on every run — lives in lib/foundation.js and is
 * amendable. This is what it was asked *this time*, and the split is the one every other
 * agent here keeps: a foundation an agent can argue with, and a brief it cannot.
 *
 * Written as a pure function of its arguments, like `workPromptFor` in lib/session.js and
 * for the same reason: it lets a test assert every branch of the brief without a tracker,
 * a checkout or a window. Anything that needs a disk read is passed in.
 */
export function epicAdvocatePrompt(workspace, p0, kids = [], plan = null, owner = 'the owner', extra = {}) {
  const { waiting = null, reason = '', corpus = null, gleaning = [] } = extra;
  const open = kids.filter((k) => String(k.status) !== 'closed');
  const done = kids.length - open.length;
  const lines = [
    `You are the P0 advocate for **${p0.id}** in \`${workspace}\`: ${p0.title}`,
    '',
    reason
      ? `You were opened because ${reason}.`
      : 'You were opened to take stock of this P0 and decide what happens next.',
    '',
    `**Owned by ${ownerOf(p0) || owner}.** They agreed to carry this; you are the thing that carries it.`,
    '',
  ];

  if (!kids.length) {
    lines.push(
      '**This P0 has no children yet, so planning it is the whole job this time.** Read the bead, read',
      'the repo, and decide what it decomposes into. File each child under it with `--parent ' + p0.id + '`',
      '— a bead filed anywhere else is a bead nothing will ever work, because a non-P0 with no P0 above',
      'it is not workable. Group them for child-workers and write each group a prompt.'
    );
  } else {
    lines.push(
      `**${open.length} of ${kids.length} children are still open** (${done} closed). Your job this time is`,
      'to decide whether the plan still fits: whether anything is stuck, whether a child should be split,',
      'and whether anything is missing that this P0 cannot finish without.'
    );
    lines.push('', ...open.slice(0, 20).map((k) => `- \`${k.id}\` P${k.priority ?? '?'} ${k.status} — ${k.title}`));
    if (open.length > 20) lines.push(`- …and ${open.length - 20} more.`);
  }

  if (plan) {
    lines.push('', '**The plan already on this bead**, which you wrote and should update rather than restate:', '', plan);
  }

  // bc-fvmx. After the plan and before the closing instructions, because it is a fact
  // about the P0 rather than something to do first — and because an agent reads what is
  // nearest the ask last.
  const requirements = requirementsSection(p0, corpus, { pending: gleaning });
  if (requirements) lines.push(requirements);

  lines.push(
    '',
    '**Before you exit, write down what you concluded.** You are re-entrant: this window closes and the',
    'next one starts from the bead, not from this conversation. In particular, put one sentence saying',
    'what this P0 is waiting on into its notes, between these markers, replacing any block already there:',
    '',
    '```',
    WAITING_OPEN,
    waiting || 'what it is waiting on, in one line',
    WAITING_CLOSE,
    '```',
    '',
    'That sentence is what the P0 card on the phone draws. A P0 stalled for a week and one quietly',
    'progressing look identical without it.',
    '',
    '**Two things you may not do.** You may not endorse anything in your own subtree — you file the work,',
    `${owner} agrees to it. And you may not change the priority or the owner of ${p0.id}: those are the`,
    'two facts the board is built out of, and they are theirs.'
  );
  return lines.join('\n');
}
