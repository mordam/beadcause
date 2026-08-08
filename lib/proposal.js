import YAML from 'yaml';

/**
 * The `beadproposal` block — an advocate asking to create beads.
 *
 * An advocate may open sessions on work that already exists without asking. What it
 * may **not** do is invent work: a bead it files on your behalf becomes something
 * you are answerable for, and a tracker that fills up with an agent's opinions is
 * worse than an empty one. So proposing is a two-step: the advocate files one
 * ordinary `human` question carrying the full text of every bead it wants, and
 * nothing is created until you press the button.
 *
 * The question's body therefore has to carry two audiences at once. Above the fold
 * it is markdown you can actually read on a phone — title, why, what done looks
 * like. Below it, this block, which is what the server creates from:
 *
 *   ```beadproposal
 *   workspace: sophab
 *   beads:
 *     - title: Cache-bust site.js
 *       type: task
 *       priority: 2
 *       description: |
 *         No ?v= on the script tag, so a shipped header change looks absent
 *         until a hard reload.
 *       acceptance: A deploy changes the URL, and an unreloaded browser gets the new file.
 *       rationale: Found while reading webapp/templates/base.html.
 *   ```
 *
 * The two must agree, and they do because both are rendered from the same parsed
 * object — the markdown above is generated from the block, never written separately.
 *
 * Deliberately the same shape as the `decision` block in decision.js: a fenced
 * block inside an ordinary issue body. beads has no schema for any of this, and
 * inventing a second mechanism to carry it would mean a second thing that can rot.
 */

const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*beadproposal[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/;

/**
 * The marker that means "yes, create them".
 *
 * The phone sends back the option's `response` string, and so does an ntfy action
 * button — there is no option id on the wire. Rather than add one and have the two
 * paths disagree, the approval option's response *starts* with this, and the server
 * treats nothing else as consent. Free text can therefore never create a bead by
 * accident: "yeah go on then" is a comment, not a command.
 */
export const APPROVE_MARKER = 'CREATE:';

export const isApproval = (response) => String(response || '').trimStart().startsWith(APPROVE_MARKER);

/** bd's own vocabulary. Anything else is a typo that would fail at the CLI. */
const TYPES = new Set(['task', 'bug', 'feature', 'epic', 'chore', 'decision']);

function normalizeBead(raw, i) {
  if (!raw) return null;
  // A bare string is a title and nothing else. Useful when the model has one
  // sentence to say, and much better than dropping it for want of a description.
  if (typeof raw === 'string') {
    const title = raw.trim();
    return title ? { title, type: 'task', priority: 2, description: '', acceptance: '', rationale: '', deps: [] } : null;
  }

  const title = String(raw.title ?? raw.summary ?? '').trim();
  if (!title) return null;

  const type = String(raw.type ?? raw.issue_type ?? 'task').toLowerCase();
  // Priority is 0–4 and arrives as a number or as "P2" depending on who wrote it.
  const p = Number(String(raw.priority ?? 2).replace(/^p/i, ''));

  return {
    title: title.slice(0, 200),
    type: TYPES.has(type) ? type : 'task',
    priority: Number.isInteger(p) && p >= 0 && p <= 4 ? p : 2,
    description: String(raw.description ?? raw.body ?? '').trim(),
    acceptance: String(raw.acceptance ?? raw.acceptance_criteria ?? '').trim(),
    design: String(raw.design ?? '').trim(),
    notes: String(raw.notes ?? '').trim(),
    // Why the advocate thinks this is worth your tracker. Kept out of the
    // description on purpose — it is an argument for creating the bead, not part
    // of the bead, and it should not outlive the decision.
    rationale: String(raw.rationale ?? raw.why ?? '').trim(),
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map((l) => String(l).trim())
      .filter((l) => l && l !== 'human'),
    // 'discovered-from:bc-4jt' or a bare id, exactly as `bd create --deps` takes it.
    deps: (Array.isArray(raw.deps) ? raw.deps : raw.deps ? [raw.deps] : [])
      .map((d) => String(d).trim())
      .filter(Boolean),
    index: i,
  };
}

/**
 * Pull the proposal out of an issue body. `null` when there isn't one, which is the
 * answer for every other question in the inbox.
 */
export function parseProposal(text) {
  const m = String(text || '').match(BLOCK_RE);
  if (!m) return null;
  let spec;
  try {
    spec = YAML.parse(m[2]);
  } catch (err) {
    // Surfaced rather than swallowed: a proposal whose block won't parse must not
    // look like a question with nothing behind it, or approving it would silently
    // create nothing at all.
    return { error: `beadproposal block is not valid YAML: ${err.message.split('\n')[0]}`, beads: [] };
  }
  if (!spec || typeof spec !== 'object') return { error: 'beadproposal block is empty', beads: [] };

  const list = Array.isArray(spec) ? spec : Array.isArray(spec.beads) ? spec.beads : [spec];
  const beads = list.map(normalizeBead).filter(Boolean);
  return {
    workspace: spec.workspace ? String(spec.workspace) : null,
    beads,
    error: beads.length ? null : 'beadproposal block lists no beads',
  };
}

const P_LABEL = ['P0 — critical', 'P1 — high', 'P2 — medium', 'P3 — low', 'P4 — backlog'];

/**
 * The question body an advocate files: the same proposal twice over, once for you
 * and once for the machine.
 *
 * "Full description" is the whole point of the ask — a line of title and two
 * buttons is what makes an agent's suggestion impossible to judge — so every field
 * that would end up on the bead is printed here, in the order you would read it.
 */
export function proposalBody(workspace, beads, { context = '' } = {}) {
  const n = beads.length;
  const parts = [];

  parts.push(
    `The **${workspace}** advocate has run out of ready work and wants to file ${
      n === 1 ? 'a bead' : `${n} beads`
    }. Nothing is created until you say so — this is the whole of what it would write.`
  );
  if (context) parts.push(context.trim());

  beads.forEach((b, i) => {
    const lines = [`### ${i + 1}. ${b.title}`, '', `\`${b.type}\` · ${P_LABEL[b.priority] || `P${b.priority}`}`];
    if (b.description) lines.push('', b.description);
    if (b.acceptance) lines.push('', `**Done when:** ${b.acceptance}`);
    if (b.design) lines.push('', `**Design:** ${b.design}`);
    if (b.notes) lines.push('', `**Notes:** ${b.notes}`);
    if (b.deps.length) lines.push('', `**Depends on:** ${b.deps.join(', ')}`);
    if (b.rationale) lines.push('', `_Why: ${b.rationale}_`);
    parts.push(lines.join('\n'));
  });

  // The two options are deliberately asymmetric in wording: "create" names the
  // number, so a mis-tap on a phone is at least a mis-tap you can read.
  const decision = [
    '```decision',
    `question: File ${n === 1 ? 'this bead' : `these ${n} beads`} in ${workspace}?`,
    'options:',
    '  - id: create',
    `    label: Create ${n === 1 ? 'it' : `all ${n}`}`,
    `    response: "${APPROVE_MARKER} file the ${n === 1 ? 'proposed bead' : `${n} proposed beads`} in ${workspace}."`,
    '  - id: no',
    '    label: No, drop it',
    '    response: "Not now — do not create these."',
    '```',
  ].join('\n');
  parts.push(decision);

  // Machine-readable, and last, because it is the part you scroll past. It is the
  // same proposal again rather than a summary of it: this block is literally what
  // `bd create` is run from, so anything the prose says that this doesn't would be
  // a promise nothing keeps.
  parts.push(
    [
      '_What would be created, in the form the server reads it:_',
      '',
      '```beadproposal',
      YAML.stringify({ workspace, beads: beads.map(strip) }).trimEnd(),
      '```',
    ].join('\n')
  );

  return parts.join('\n\n');
}

/** What goes in the block: no synthesised fields, no empties, no index. */
function strip(b) {
  const out = { title: b.title, type: b.type, priority: b.priority };
  for (const k of ['description', 'acceptance', 'design', 'notes', 'rationale']) if (b[k]) out[k] = b[k];
  if (b.labels?.length) out.labels = b.labels;
  if (b.deps?.length) out.deps = b.deps;
  return out;
}

/** A one-line title for the question itself. */
export function proposalTitle(workspace, beads) {
  if (beads.length === 1) return `Create a bead in ${workspace}: ${beads[0].title}`.slice(0, 160);
  return `Create ${beads.length} beads in ${workspace}?`;
}
