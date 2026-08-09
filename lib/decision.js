import YAML from 'yaml';
import { splitProposal } from './proposal.js';
import { splitAmendment } from './amendment.js';
import { splitDelivery } from './delivery.js';

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
 *     - net            # a bare string works too
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

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o, i) => {
      if (o == null) return null;
      if (typeof o === 'string') return { id: slug(o) || `opt${i}`, label: o, response: o, hint: '' };
      const label = String(o.label ?? o.title ?? o.id ?? '').trim();
      if (!label) return null;
      return {
        id: String(o.id ?? slug(label)),
        label,
        response: String(o.response ?? o.answer ?? label),
        hint: String(o.hint ?? o.detail ?? ''),
      };
    })
    .filter(Boolean);
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
      options: normalizeOptions(spec.options),
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
    sections,
    errors,
  };
}
