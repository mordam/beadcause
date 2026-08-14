import YAML from 'yaml';
import { splitProposal } from './proposal.js';
import { splitAmendment } from './amendment.js';
import { splitDelivery } from './delivery.js';
import { suggestFromSections } from './suggest.js';
import { addresseesOf } from './addressee.js';
import { modelCard } from './modelcard.js';

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

const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*decision[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

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

function normalizeOptions(raw, recommend) {
  if (!Array.isArray(raw)) return [];
  const options = raw
    .map((o, i) => {
      if (o == null) return null;
      if (typeof o === 'string')
        return { id: slug(o) || `opt${i}`, label: o, response: o, hint: '', recommended: false, closes: true };
      const label = String(o.label ?? o.title ?? o.id ?? '').trim();
      if (!label) return null;
      return {
        id: String(o.id ?? slug(label)),
        label,
        response: String(o.response ?? o.answer ?? label),
        hint: String(o.hint ?? o.detail ?? ''),
        recommended: o.recommended === true || o.recommend === true,
        closes: closesFlag(o.closes),
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
