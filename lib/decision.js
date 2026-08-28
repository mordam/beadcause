import YAML from 'yaml';
import { splitProposal } from './proposal.js';
import { splitAmendment } from './amendment.js';
import { splitDelivery } from './delivery.js';
import { suggestFromSections } from './suggest.js';
import { addresseesOf } from './addressee.js';
import { modelCard } from './modelcard.js';
import { approvalCard } from './approvalcard.js';

/**
 * The `decision` block.
 *
 * beads has no schema for "a question with options", so the agent writes one
 * into the issue body as a fenced block:
 *
 *   ```decision
 *   question: Charge the platform fee on gross or net?
 *   options:
 *     - id: gross
 *       label: Gross
 *       response: "Gross — fee on the full charge amount."
 *       hint: Simpler to reconcile
 *       recommended: true
 *     - id: build-both
 *       label: Build both as written
 *       closes: false  # a commission, not a verdict — answers without closing
 *     - id: park
 *       label: Not yet — leave it on the list
 *       defers: true   # answers without closing *and* keeps the card in the inbox
 *     - net            # a bare string works too
 *   recommend: gross   # or name it here instead, by id or by label
 *   diagram: |
 *     graph LR
 *       Buyer --> Platform --> Seller
 *   links:
 *     - [Stripe docs](https://docs.stripe.com/connect)
 *   images:
 *     - /Users/you/code/acme/current-flow.png
 *   ```
 *
 * Everything outside the block is ordinary markdown context. No block at all is
 * fine — the question then renders as free-text-answer-only.
 */

// The closing fence is anchored to the start of a line too (the lookbehind), not just
// the opening one — otherwise a fenced block *inside* the surrounding text, indented by
// something upstream, terminates this block early and drops everything after it. See
// bc-ka5y.23; lib/proposal.js and lib/beadfiles.js carry the same fix.
const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*decision[ \t]*\r?\n([\s\S]*?)(?<=^|\n)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/**
 * `- [Docs](https://x)` is the obvious way to write a link and is invalid YAML —
 * the `[` opens a flow sequence. Quote those list items before parsing so the
 * natural spelling works.
 */
function forgiveMarkdownLinks(yamlText) {
  return yamlText.replace(/^(\s*-\s+)(\[[^\]\n]*\]\([^)\n]*\))\s*$/gm, (_, lead, link) => `${lead}"${link.replace(/"/g, '\\"')}"`);
}

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'opt';

/**
 * `closes: false` — an option that is an instruction rather than a verdict.
 *
 * Answering closes the bead, because a question that has been answered is
 * finished. That is true of a conclusion and wrong of a **commission**: three of
 * bc-goo.2's four options were build orders ("Build both as written", "Build the
 * API only"), and closing on one of those filed the work as done in the same breath
 * as ordering it. A session then had to reopen the bead by hand to do what it had
 * just been told to do, and the reopen is what put the card back in the inbox and
 * collected the same answer twice.
 *
 * So an option may say it does not close. `false` in YAML is a boolean, but `no`
 * and `"false"` are strings under the core schema the parser uses, and an agent
 * writing either of those means the same thing — reading them as truthy would leave
 * the bead closed and the mistake invisible until somebody noticed the work had not
 * started. Anything else, including absence, is the ordinary closing option.
 */
const closesFlag = (raw) => {
  if (raw === false) return false;
  const word = String(raw ?? '').trim().toLowerCase();
  return !(word === 'false' || word === 'no' || word === 'off');
};

/**
 * `defers: true` — an option that means *not yet, ask me again later*.
 *
 * The **second** kind of non-closing answer, and for a while `closes: false` was the
 * only way to write either of them. That is what bc-7qo.11 is: bc-7qo.10 offered
 *
 *     - id: park
 *       label: Not yet — leave it blocked
 *       hint: Keeps this card on the list.
 *       closes: false
 *
 * and tapping it took the `human` label off, reopened the bead and dropped the claim —
 * the commission path, which is exactly right for "build both as written" and exactly
 * backwards here. The card fell out of the inbox into `bd ready`, and the next advocate
 * tick opened a worker window on the question that had just been deferred. The hint said
 * "keeps this card on the list" and the machinery did the opposite of it.
 *
 * The two are not the same answer and cannot be told apart by a boolean: both leave the
 * bead open, and what differs is *who has it next*. A commission hands it to an agent; a
 * deferral hands it to nobody. So an option says which, and a deferral is `closes: false`
 * **plus** this — `defers` forces `closes` false in `normalizeOptions`, so every surface
 * that already reads `closes === false` keeps treating a deferral as non-closing, which
 * is the half of it they all get right.
 *
 * **What "not yet" does to the card changed in bc-y9cof, and the flag did not.** It used
 * to leave the card in the inbox with its options — literally *leave this on the list* —
 * and that was read, correctly, as the app not having heard the answer: the next sweep
 * drew the same question with "⟳ You answered this 1m ago" above three options still
 * asking to be tapped. So the answer now sets the card aside instead (`setAside` in
 * lib/server.js), on the same record `/api/dismiss` writes, and it comes back when its
 * gate clears or somebody comments. Nothing about the bead moves either way, which is
 * why this is still one flag: what it declares is that the option decides nothing and
 * commissions nothing, and where the card goes is beadcause's business, not the bead's.
 *
 * True-ish words rather than a bare `=== true`, and for the mirror image of the reason in
 * `closesFlag`: YAML's core schema reads `yes` and `on` as the strings "yes" and "on", and
 * an agent writing `defers: yes` means this. The unrecognised value falls to `false`,
 * which is the ordinary option — a spelling nobody reads must not silently invent a third
 * ending, because a deferral misread as a commission hands work to an agent, while a
 * commission misread as a deferral quietly hides the card instead of starting anything.
 */
const defersFlag = (raw) => {
  if (raw === true) return true;
  const word = String(raw ?? '').trim().toLowerCase();
  return word === 'true' || word === 'yes' || word === 'on';
};

function normalizeOptions(raw, recommend) {
  if (!Array.isArray(raw)) return [];
  const options = raw
    .map((o, i) => {
      if (o == null) return null;
      if (typeof o === 'string')
        return { id: slug(o) || `opt${i}`, label: o, response: o, hint: '', recommended: false, closes: true, defers: false };
      const label = String(o.label ?? o.title ?? o.id ?? '').trim();
      if (!label) return null;
      const defers = defersFlag(o.defers ?? o.defer);
      return {
        id: String(o.id ?? slug(label)),
        label,
        response: String(o.response ?? o.answer ?? label),
        hint: String(o.hint ?? o.detail ?? ''),
        recommended: o.recommended === true || o.recommend === true,
        // A deferral does not close, whatever else the option says — and `closes: true`
        // beside `defers: true` is a block contradicting itself rather than a third
        // shape. `defers` wins, because it is the more specific statement of the two and
        // the only one of them that can be wrong in the direction that loses the card.
        closes: defers ? false : closesFlag(o.closes),
        defers,
      };
    })
    .filter(Boolean);

  // `recommend: gross` beside the list is the other spelling, and it is the one
  // an agent reaches for when the recommendation is a conclusion drawn after
  // writing the options rather than a property of one of them.
  const named = String(recommend ?? '').trim().toLowerCase();
  if (named) {
    const hit = options.find((o) => o.id.toLowerCase() === named || o.label.toLowerCase() === named);
    if (hit) for (const o of options) o.recommended = o === hit;
  }

  // One star. Two is the block contradicting itself, and the card is the wrong
  // place to find that out — the first one written wins, as it does in prose.
  let starred = false;
  for (const o of options) {
    if (o.recommended && starred) o.recommended = false;
    else if (o.recommended) starred = true;
  }
  return options;
}

function normalizeLinks(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((l) => {
      if (!l) return null;
      if (typeof l === 'object') {
        const url = String(l.url ?? l.href ?? '').trim();
        return url ? { label: String(l.label ?? l.title ?? url), url } : null;
      }
      const s = String(l).trim();
      const md = s.match(/^\[([^\]]*)\]\(([^)]+)\)$/); // [label](url)
      if (md) return { label: md[1] || md[2], url: md[2] };
      return s ? { label: s.replace(/^https?:\/\//, ''), url: s } : null;
    })
    .filter(Boolean);
}

const asList = (raw) =>
  (Array.isArray(raw) ? raw : raw ? [raw] : []).map((s) => String(s).trim()).filter(Boolean);

/** Files on the Mac you're being asked to read. Opened in a reader tab. */
function normalizeDocs(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((d) => {
      if (!d) return null;
      if (typeof d === 'object') {
        const p = String(d.path ?? d.file ?? d.url ?? '').trim();
        return p ? { label: String(d.label ?? d.title ?? p.split('/').pop()), path: p } : null;
      }
      const s = String(d).trim();
      const md = s.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      if (md) return { label: md[1] || md[2], path: md[2] };
      return s ? { label: s.split('/').pop(), path: s } : null;
    })
    .filter(Boolean);
}

/**
 * The option a client says it tapped, as the **bead** defines it.
 *
 * The phone sends an id alongside the sentence, and this is what turns that id back
 * into the option the agent wrote — deliberately by re-reading the bead rather than
 * by trusting what arrived. Whether an answer closes the bead is the bead's call,
 * not the caller's: a client that could name its own `closes: false` could leave any
 * question open, and one running against a stale card could close a commission the
 * agent has since marked otherwise.
 *
 * Null for an unknown id, which is the answer for a card drawn before the block
 * changed underneath it — and it fails towards the old behaviour, a close.
 */
export function optionById(question, id) {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return (question?.decision?.options || []).find((o) => o.id === wanted) || null;
}

/**
 * Split an issue body into { decision, body }.
 * `decision` is null when the issue carries no block.
 */
export function parseDecision(text) {
  const src = text || '';
  const m = src.match(BLOCK_RE);
  if (!m) return { decision: null, body: src.trim(), raw: null };

  const body = (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();
  let spec;
  try {
    spec = YAML.parse(forgiveMarkdownLinks(m[2]));
  } catch (err) {
    // Surface the failure rather than silently dropping to free-text — a broken
    // block on the phone otherwise just looks like a question with no options.
    return {
      decision: null,
      body,
      raw: m[2],
      error: `decision block is not valid YAML: ${err.message.split('\n')[0]}`,
    };
  }
  if (!spec || typeof spec !== 'object') return { decision: null, body, raw: m[2] };

  const diagrams = asList(spec.diagrams ?? spec.diagram);
  return {
    decision: {
      question: spec.question ? String(spec.question) : '',
      context: spec.context ? String(spec.context) : '',
      options: normalizeOptions(spec.options, spec.recommend ?? spec.recommended),
      diagrams,
      links: normalizeLinks(spec.links),
      docs: normalizeDocs(spec.docs ?? spec.doc ?? spec.files ?? spec.read),
      images: asList(spec.images ?? spec.image),
      allowFreeText: spec.freeText !== false,
    },
    body,
    raw: m[2],
  };
}

/**
 * Every `decision` block in a body, and the body with all of them taken out.
 *
 * `parseDecision` answers "what is the question on this bead" and deliberately stops at
 * the first block, because that is the one the phone draws. This answers the other
 * question — "what blocks are on this bead at all, and what does the prose look like
 * without them" — and it exists because retiring a spent block is *surgery*, and surgery
 * needs the offcut kept.
 *
 * Three things it does that a caller writing its own regex gets wrong:
 *
 * - **Every block, not the first.** A field can carry two: a machine sweep appends its
 *   own card to `notes` (`supersedeAsk`, `inMainAsk`, `finishedEpicAsk` all do), and a
 *   worker that has already appended one leaves the second shadowed and invisible. A cut
 *   that removes only the first leaves a bead still carrying a question.
 * - **The block verbatim, fences and all.** `parseDecision.raw` is the *inner* YAML, and
 *   an archival copy rebuilt from it has lost the fence the author wrote (```` ``` ````
 *   vs `~~~`) and any trailing spaces on the fence line. "Preserved verbatim" has to mean
 *   the bytes.
 * - **The seam, once.** Removing a block from the middle of prose leaves the paragraph
 *   above it butted against the one below, so the join is a single `\n` — the same join
 *   `parseDecision` makes, for the same reason.
 *
 * Returns `{ body, blocks }`, where each block is `{ text, raw }` in the order they
 * appeared: `text` is the fenced block exactly as it was written (without the newline
 * the pattern eats in front of it), `raw` its inner YAML. `blocks` is empty and `body`
 * is the input, trimmed, for the ordinary bead that carries no block at all.
 */
export function stripDecisionBlocks(text) {
  let src = String(text || '');
  const blocks = [];
  for (;;) {
    const m = src.match(BLOCK_RE);
    if (!m) break;
    const lead = m[1].length; // the '\n' the pattern eats before the opening fence
    blocks.push({ text: m[0].slice(lead), raw: m[2] });
    // The seam, and only the seam: the newlines that were touching the block on either
    // side go with it, and what is left is joined by one blank line — the ordinary
    // markdown paragraph break. Collapsing blank runs anywhere else would be a change to
    // prose this was not asked to touch, and the whole point of a cutter over a rewrite
    // is that everything it did not cut comes back byte for byte.
    const before = src.slice(0, m.index).replace(/\n+$/, '');
    const after = src.slice(m.index + m[0].length).replace(/^\n+/, '');
    src = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
  return { body: src.trim(), blocks };
}

/**
 * The tail every question ends with, as text an agent can be handed.
 *
 * Everything above is the *grammar* of the block. This is the **rule**, and it lives here
 * rather than in the briefs because four places have to say the same thing — the worker's
 * ask, the epic planner's ask, the refusal in `bin/ask.js`, and the README — and four
 * copies of a template is four copies that drift. The one that drifted first would be the
 * one an agent actually read.
 *
 * The rule is: **a question ends with a `decision` block, and one option in it is
 * recommended.** Not "may carry one". The block has existed for as long as this file has
 * and the briefs never mentioned it — what a worker was told to write was prose, "if
 * there are only a few possible answers, list them". Prose is exactly what lib/suggest.js
 * exists to salvage, by guessing options out of sentences never written to be parsed. A
 * guessed option is not a worse version of a written one, it is a different thing, and
 * the card says so by filling the answer box rather than sending it. So the common case
 * has been Adam reading the salvaged version of a question nobody wrote as one.
 *
 * Four parts of the shape below are load-bearing rather than decoration:
 *
 * - **At the bottom, with nothing after it.** A block in the middle of a brief is a block
 *   whose context arrives after the ask, and the reader has to hold the question in their
 *   head while the reasoning catches up. Prose first, then the ask, then stop —
 *   `decisionTail` checks the *position*, not merely the presence, because "somewhere in
 *   there" is the state we already had.
 * - **One option carries `recommended: true`.** A question with options and no
 *   recommendation hands back the comparison the agent has already done, and the agent
 *   did it with the files open. It stays theirs to overrule — tapping an option writes
 *   the answer into a box rather than sending it — so a recommendation costs nothing and
 *   a missing one costs a re-derivation on a phone.
 * - **`response` on every option, as a sentence.** It is the literal text recorded as the
 *   answer, and the next agent reads that rather than the card: "Gross" is a button
 *   label, "Gross — take the platform fee on the full charge amount" is an answer.
 * - **A third option demonstrates `defers: true`.** Everything above teaches an agent to
 *   write two closing options and nothing else, because neither one shows `closes:` or
 *   `defers:` at all — both fall through to the default in `closesFlag`, which reads an
 *   absent key as a close. That is fine for a genuine conclusion, but the ordinary third
 *   shape of a question to Adam is "not yet, ask me again later", and a session with no
 *   cue that the field exists writes that as a plain option and closes the bead in the
 *   same breath as asking to keep it open (bc-khoe.30.1's near-miss, and bc-goo.2's actual
 *   one). `defers: true` is the field to demonstrate rather than `closes: false` — see the
 *   doc comment on `defersFlag` above — because a bare `closes: false` is read as a
 *   *commission* (`lib/server.js`'s `Bd.commission`), which takes `human` off and hands the
 *   deferred question to an advocate to open a worker on, the opposite of putting it off
 *   (bc-7qo.10). This third option does not carry `recommended: true` of its own; the
 *   point is to show the key exists, not to suggest deferring is usually the right answer.
 *   Since bc-y9cof the card goes off Adam's list when he taps it and comes back when the
 *   bead's gate clears, so word the label for the *condition* — "not yet, ask me again
 *   when the children have merged" — rather than for the list it used to sit on.
 *
 * And the one honest exception, which is why `bin/ask.js` has a flag rather than only a
 * check: some questions have no options at all. "What is the staging database password"
 * is a fact, not a choice, and a block invented for it would offer the reader two made-up
 * answers to a question that has one real one. That is worse than no block. The escape is
 * deliberately narrow, and named for what it means rather than for the check it skips.
 */
const ASK_TAIL_LINES = [
  '```decision',
  'question: <the one thing you need decided, as a question>',
  'options:',
  '  - id: <short-slug>',
  '    label: <the choice, in a few words>',
  '    hint: <what it costs or buys — one clause>',
  '    response: <the full sentence recorded as the answer, for the agent that acts on it>',
  '    recommended: true',
  '  - id: <short-slug>',
  '    label: <the other choice>',
  '    hint: <what it costs or buys>',
  '    response: <the full sentence recorded as the answer>',
  '  - id: <short-slug>',
  '    label: <not yet — ask me again when X has happened>',
  '    hint: <what it costs or buys>',
  '    response: <the full sentence recorded as the answer>',
  '    defers: true   # answers without closing; sets the card aside until its gate clears',
  '```',
];

/** The template, indented to sit inside a heredoc or a markdown code block. */
export function askTemplate(indent = '') {
  return ASK_TAIL_LINES.map((l) => (l ? indent + l : l)).join('\n');
}

/**
 * Is this body a question that ends the way a question has to end?
 *
 * Returns `{ ok, reason }`, and `reason` is written to be printed *at an agent*: it names
 * the one thing that is wrong and nothing else. The three failures are genuinely
 * different mistakes — no block at all (the common case, and the one the briefs are
 * fixing), a block that is not last (context arriving after the ask), and options nobody
 * recommended (the comparison handed back).
 *
 * A block with **no** options passes here, and that is not an oversight: free-text
 * questions exist, and `bin/ask.js` polices the choice-less question with its own flag
 * rather than by pretending an empty list is a failure of this function.
 */
export function decisionTail(text) {
  const src = String(text || '');
  const m = src.match(BLOCK_RE);
  if (!m) {
    return { ok: false, reason: 'the body carries no `decision` block, so the question reaches the phone with no options on it' };
  }
  if (src.slice(m.index + m[0].length).trim()) {
    return {
      ok: false,
      reason: 'the `decision` block is not the last thing in the body — context that arrives after the ask is context read too late',
    };
  }
  const { decision, error } = parseDecision(src);
  if (error) return { ok: false, reason: error };
  const options = decision?.options || [];
  if (options.length && !options.some((o) => o.recommended)) {
    return {
      ok: false,
      reason: 'no option is marked `recommended: true` — you did the comparison with the files open, so say which way you would go',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Build the phone-facing question object from a bd issue record.
 * Looks for the block in description, then design, then notes.
 */
export function toQuestion(workspaceName, issue) {
  const fields = ['description', 'design', 'notes'];
  let decision = null;
  let proposal = null;
  let amendment = null;
  let delivery = null;
  const sections = [];
  const errors = [];
  for (const f of fields) {
    const val = issue[f];
    if (!val) continue;
    // The proposal block comes out first, so the decision parse — and the markdown
    // that survives both — never sees it. An advocate's ask carries every field of
    // every bead it wants twice over, once as prose and once as YAML, and only the
    // prose belongs on a phone screen.
    const split = splitProposal(val);
    if (split.proposal && !proposal) proposal = split.proposal;
    if (split.proposal?.error) errors.push(`${f}: ${split.proposal.error}`);
    // And the same again for an agent asking to change what it is. Same reason, same
    // shape: the prose above the block is generated from the block, so stripping it
    // loses nothing a phone was going to read.
    const amend = splitAmendment(split.body);
    if (amend.amendment && !amendment) amendment = amend.amendment;
    if (amend.amendment?.error) errors.push(`${f}: ${amend.amendment.error}`);
    // And once more for a worker handing back a pull request. Same reason again:
    // the prose above the block says everything the block does, and the block is
    // what the merge acts on — so it is machinery, and machinery should not be the
    // biggest thing on the card you are deciding from.
    const deliv = splitDelivery(amend.body);
    if (deliv.delivery && !delivery) delivery = deliv.delivery;
    if (deliv.delivery?.error) errors.push(`${f}: ${deliv.delivery.error}`);
    const parsed = parseDecision(deliv.body);
    if (parsed.decision && !decision) decision = parsed.decision;
    if (parsed.error) errors.push(`${f}: ${parsed.error}`);
    if (parsed.body) sections.push({ field: f, markdown: parsed.body });
  }

  /**
   * Buttons for a question nobody wrote buttons for.
   *
   * Only ever a fallback, and the four exclusions are the whole of its judgement:
   * a card that already has options has them from the agent and does not need a
   * guess; a proposal, an amendment and a delivery each draw their own controls,
   * and a second set of chips beside those would be two answers to one question
   * disagreeing about what the question is. See lib/suggest.js.
   */
  const suggested =
    decision?.options?.length || proposal || amendment || delivery ? null : suggestFromSections(sections);

  return {
    workspace: workspaceName,
    id: issue.id,
    key: `${workspaceName}/${issue.id}`,
    title: issue.title || issue.id,
    priority: issue.priority ?? null,
    type: issue.issue_type || 'task',
    status: issue.status,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    createdBy: issue.created_by || issue.owner || '',
    // Who this question is for, off its `for:<handle>` labels — `[]` for the
    // unaddressed question, which is nearly all of them and is everybody's. Read here,
    // once per sweep, so the push path, the card and the log all answer from one parse
    // rather than three; see lib/addressee.js for why it lives on the bead at all.
    addressees: addresseesOf(issue.labels),
    // Which model a session on this bead runs, and which one it actually ran — read
    // here for the same reason `addressees` is, and with more force. The tier is a
    // label and the answer is a *mapping* over it, so a browser working it out for
    // itself would be a second copy of the routing decision drifting quietly from the
    // one that spawns the windows. Derived once, in lib/modelcard.js, and the bead
    // sheet on /graph is handed the identical field. See bc-nc6o.4.
    model: modelCard(issue),
    // Where the *ruling* on this bead is, if it is a thing anybody rules on — the second
    // axis beside the pull request, off deluvia's approval labels. `null` for every bead
    // outside that pipeline, which is nearly all of them and is why this is a field that
    // is usually absent rather than one that is usually empty: every inbox payload pays
    // for whatever is added to it. Derived once in lib/approvalcard.js and handed to the
    // bead sheet unchanged, for the same reason `model` is. See bc-bmry.5 / dv-uhl.
    approval: approvalCard(issue),
    commentCount: issue.comment_count ?? 0,
    dependentCount: issue.dependent_count ?? 0,
    question: decision?.question || issue.title || '',
    decision,
    // Present only on an advocate's ask. The app draws a row per bead with its own
    // approve and decline, plus the two bulk controls; `null` everywhere else, which
    // is every other question in the inbox.
    proposal: proposal && !proposal.error ? { beads: proposal.beads } : null,
    // Present only when an agent is asking to change what it is. The body already
    // reads as prose without it; this is here so a surface can tell a constitutional
    // question apart from a question about work without re-parsing the description.
    amendment: amendment && !amendment.error ? amendment : null,
    // Present only on a worker's delivery: the PR whose merge is this question's
    // answer. Identity and intent only — the diffstat and the check state are read
    // live from `gh` when the card is drawn, because a frozen diffstat is wrong the
    // moment anyone pushes to the branch. See lib/delivery.js.
    delivery: delivery && !delivery.error ? delivery : null,
    // Options read out of the prose when the bead carries no block: `{ from, options }`,
    // or null, which is the common case. Deliberately not merged into `decision.options`
    // — these were extracted rather than written, so they fill the answer box instead of
    // sending it. See lib/suggest.js.
    suggested,
    sections,
    errors,
  };
}
