import YAML from 'yaml';
import { splitComplexity } from './complexity.js';

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

/**
 * Which of the proposed beads an answer approves.
 *
 * `null` when the answer is not an approval at all. `{ all: true }` for a bare
 * `CREATE:` — what the ntfy button and the bulk control send. `{ indices: [1, 3] }`
 * when the marker is followed by numbers, which are **1-based**, matching the
 * numbered headings in the body you are looking at when you type them.
 *
 * The numbers have to come *immediately* after the marker, so the sentence that
 * follows a bulk approval ("CREATE: file the 2 proposed beads") cannot be misread as
 * picking bead 2. The app never relies on this — it sends the indices as a field —
 * but a notification button and a typed answer have only text to work with.
 */
export function parseApproval(response) {
  const text = String(response || '').trimStart();
  if (!text.startsWith(APPROVE_MARKER)) return null;
  const rest = text.slice(APPROVE_MARKER.length).trim();
  const m = rest.match(/^(\d+(?:\s*[,+ ]\s*\d+)*)(?![^\s,+])/);
  if (!m) return { all: true, indices: [] };
  const indices = [...new Set(m[1].split(/\D+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
  return indices.length ? { all: false, indices } : { all: true, indices: [] };
}

/**
 * Split a body into { proposal, body } the way parseDecision does for its own block,
 * so the YAML never reaches the phone as a wall of text it has to scroll past. The
 * app renders the parsed beads as rows with their own approve and decline controls;
 * the block is machinery, and machinery should not be the biggest thing on the card.
 */
export function splitProposal(text) {
  const src = String(text || '');
  const m = src.match(BLOCK_RE);
  if (!m) return { proposal: null, body: src };
  const body = (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();
  return { proposal: parseProposal(src), body };
}

/** bd's own vocabulary. Anything else is a typo that would fail at the CLI. */
const TYPES = new Set(['task', 'bug', 'feature', 'epic', 'chore', 'decision']);

/**
 * One proposed bead, clamped into the shape everything downstream expects.
 *
 * Exported because a proposed bead is no longer only ever something a model wrote in a
 * block: `amendment.beyondAmendment` builds one in code, for a request an amendment is
 * not allowed to grant. That bead has to be *the same shape* as a parsed one — same
 * type vocabulary, same priority clamp, same fields present — because `proposalBody`
 * renders it and `createProposed` files it with no idea which of the two it is. Two
 * constructors and one consumer is how a card ends up rendering `undefined`.
 */
export function normalizeBead(raw, i = 0) {
  if (!raw) return null;
  // A bare string is a title and nothing else. Useful when the model has one
  // sentence to say, and much better than dropping it for want of a description.
  if (typeof raw === 'string') {
    const title = raw.trim();
    return title
      ? {
          title,
          type: 'task',
          priority: 2,
          complexity: '',
          description: '',
          acceptance: '',
          rationale: '',
          deps: [],
          duplicate: null,
        }
      : null;
  }

  const title = String(raw.title ?? raw.summary ?? '').trim();
  if (!title) return null;

  const type = String(raw.type ?? raw.issue_type ?? 'task').toLowerCase();
  // Priority is 0–4 and arrives as a number or as "P2" depending on who wrote it.
  const p = Number(String(raw.priority ?? 2).replace(/^p/i, ''));
  // How hard it is, which is what decides the model a session on it runs (bc-nc6o).
  // Read as a field or as a `complexity:` label, because both say the same thing and an
  // agent writing YAML will reach for whichever it saw last; from here on it is one
  // field, so the card, the block and the bead cannot disagree. Anything that is not a
  // tier is dropped rather than guessed at — see lib/complexity.js — and an untiered
  // bead is legal everywhere.
  const { labels, tier } = splitComplexity(
    (Array.isArray(raw.labels) ? raw.labels : []).map((l) => String(l).trim()).filter((l) => l && l !== 'human'),
    raw.complexity ?? raw.tier
  );

  return {
    title: title.slice(0, 200),
    type: TYPES.has(type) ? type : 'task',
    priority: Number.isInteger(p) && p >= 0 && p <= 4 ? p : 2,
    complexity: tier,
    description: String(raw.description ?? raw.body ?? '').trim(),
    acceptance: String(raw.acceptance ?? raw.acceptance_criteria ?? '').trim(),
    design: String(raw.design ?? '').trim(),
    notes: String(raw.notes ?? '').trim(),
    // Why the advocate thinks this is worth your tracker. Kept out of the
    // description on purpose — it is an argument for creating the bead, not part
    // of the bead, and it should not outlive the decision.
    rationale: String(raw.rationale ?? raw.why ?? '').trim(),
    labels,
    // 'discovered-from:bc-4jt' or a bare id, exactly as `bd create --deps` takes it.
    deps: (Array.isArray(raw.deps) ? raw.deps : raw.deps ? [raw.deps] : [])
      .map((d) => String(d).trim())
      .filter(Boolean),
    // What this looks like a duplicate of, if lib/dupe.js found something. Not written
    // by the agent that proposed — it is stamped on afterwards, and it survives the
    // round trip through the YAML block because that block is what the card is
    // rendered from. Without it a flag would be visible on the console for one second
    // and gone from the thing Adam actually taps.
    duplicate: normalizeDuplicate(raw.duplicate),
    index: i,
  };
}

/** `{ id, title, status }` or null. Anything else on that key is not a verdict. */
function normalizeDuplicate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  return { id, title: String(raw.title ?? '').trim(), status: String(raw.status ?? 'open').trim() || 'open' };
}

/**
 * One line naming what a row duplicates — the same sentence on the card, in the log,
 * and in the comment a refused create leaves on the thread.
 *
 * Here rather than in lib/dupe.js so nothing in the dedupe path has to import this
 * file back: dupe.js reads proposals, and a cycle between the two would be one more
 * thing to be careful about for no gain.
 */
export function dupeNote(dup) {
  if (!dup) return '';
  const what = dup.title ? ` — “${dup.title}”` : '';
  if (dup.status === 'proposed') {
    return String(dup.id).startsWith('#')
      ? `the same bead as ${dup.id} in this proposal${what}`
      : `already proposed in ${dup.id}, still waiting on you${what}`;
  }
  return `already ${dup.status} as ${dup.id}${what}`;
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

/**
 * Adjust: a proposed bead as you rewrote it, rather than as the agent wrote it.
 *
 * ✓ and ✕ are a verdict on someone else's sentence, and the common case is neither
 * — the bead is worth filing but the title is wrong, or it is a P1 and not a P3.
 * Without a third option that lands as a decline, and the work comes back next week
 * phrased the same way, because nothing recorded what was actually wrong with it.
 *
 * `edits` is `{ "1": { title, type, priority, description, acceptance, labels } }`,
 * keyed by the same 1-based numbers printed beside the beads — the numbers you are
 * looking at when you change one are the numbers that travel. Every edited bead goes
 * back through `normalizeBead`, so a priority typed as "high" or a type the CLI has
 * never heard of is clamped here rather than failing at `bd create` with half the
 * proposal already filed.
 *
 * Anything absent from an edit keeps the agent's value; an edit for an index that
 * isn't in the proposal is ignored rather than appended, because a client sending a
 * stale index means the proposal changed under it, and inventing a bead from that is
 * the one outcome nobody asked for.
 */
export function applyEdits(beads, edits) {
  if (!edits || typeof edits !== 'object') return beads;
  return beads.map((b, i) => {
    const patch = edits[String(i + 1)] ?? edits[i + 1];
    if (!patch || typeof patch !== 'object') return b;
    const merged = normalizeBead({ ...b, ...patch }, i);
    // A cleared title is the one field that cannot be honoured — an untitled bead
    // is not a bead — so it falls back rather than dropping the row silently.
    return merged || b;
  });
}

/** Which of these beads differ from what the agent proposed, by 1-based number. */
export function editedIndices(original, edited) {
  const out = [];
  for (let i = 0; i < original.length; i++) {
    if (JSON.stringify(strip(original[i])) !== JSON.stringify(strip(edited[i] || original[i]))) out.push(i + 1);
  }
  return out;
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
export function proposalBody(workspace, beads, { context = '', intro = '' } = {}) {
  const n = beads.length;
  const what = n === 1 ? 'a bead' : `${n} beads`;
  const parts = [];

  // Two things propose beads now, and the difference is worth a sentence. An
  // advocate proposes because the queue ran dry, which is a considered survey of a
  // repo at rest. A worker proposes because it *tripped over something* while doing
  // other work — a discovery, or a conflict it must not resolve on its own — and
  // that one arrives while the thing that found it is still going. Reading "has run
  // out of ready work" on a card filed by a session mid-flight is simply false, and
  // a false lead sentence is how you learn to stop reading lead sentences.
  parts.push(
    (intro || `The **${workspace}** advocate has run out of ready work and wants to file ${what}.`) +
      ` Nothing is created until you say so — this is the whole of what it would write.${
        n > 1 ? ' Approve, adjust or decline each one separately in the app, or answer `CREATE: 1,3` to pick by number.' : ''
      }`
  );
  // Said once, at the top, and again on the row. A duplicate is the one thing on this
  // card that changes what a tap *means* — approving a bead that already exists opens a
  // second session onto work somebody is already doing (bc-9frx) — and it must not be
  // discoverable only by scrolling to the row it belongs to.
  const dupes = beads.map((b, i) => ({ b, n: i + 1 })).filter(({ b }) => b.duplicate?.id);
  if (dupes.length) {
    parts.push(
      `⚠︎ **${dupes.length === 1 ? 'One of these looks' : `${dupes.length} of these look`} like work that already exists** — ` +
        `${dupes.map(({ b, n }) => `${n}. ${dupeNote(b.duplicate)}`).join('; ')}. ` +
        'Approving anyway is a fine answer if the existing bead is not the same thing; approving by accident costs a whole session.'
    );
  }
  if (context) parts.push(context.trim());

  beads.forEach((b, i) => {
    // The tier is on the same line as the type and the priority because it is the same
    // kind of fact — what this bead *is* — and because it is the one of the three you
    // are most likely to want to change before approving: it decides which model runs
    // the session, and you are the last reader before that happens (bc-nc6o).
    const facts = [`\`${b.type}\``, P_LABEL[b.priority] || `P${b.priority}`];
    if (b.complexity) facts.push(`${b.complexity} complexity`);
    const lines = [`### ${i + 1}. ${b.title}`, '', facts.join(' · ')];
    if (b.duplicate?.id) lines.push('', `⚠︎ **Possible duplicate:** ${dupeNote(b.duplicate)}`);
    if (b.description) lines.push('', b.description);
    if (b.acceptance) lines.push('', `**Done when:** ${b.acceptance}`);
    if (b.design) lines.push('', `**Design:** ${b.design}`);
    if (b.notes) lines.push('', `**Notes:** ${b.notes}`);
    if (b.deps.length) lines.push('', `**Depends on:** ${b.deps.join(', ')}`);
    if (b.rationale) lines.push('', `_Why: ${b.rationale}_`);
    parts.push(lines.join('\n'));
  });

  // Two options only, even though the app offers a choice per bead: these exist for
  // the paths that can carry nothing but a button — an ntfy action, and a typed
  // answer. Per-bead approval rides on `CREATE: 1,3`, which those can express too,
  // just not as comfortably.
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
  // Only when it was named. An absent key is a bead nobody rated, which is a different
  // thing from one rated `medium`, and the router treats them differently (bc-nc6o).
  if (b.complexity) out.complexity = b.complexity;
  for (const k of ['description', 'acceptance', 'design', 'notes', 'rationale']) if (b[k]) out[k] = b[k];
  if (b.labels?.length) out.labels = b.labels;
  if (b.deps?.length) out.deps = b.deps;
  // The one field here that is not something `bd create` takes. It is in the block
  // because the block is what the phone re-parses to draw the row, and a duplicate
  // warning that does not survive being written to the bead is a warning nobody sees.
  if (b.duplicate?.id) out.duplicate = b.duplicate;
  return out;
}

/** A one-line title for the question itself. */
export function proposalTitle(workspace, beads) {
  if (beads.length === 1) return `Create a bead in ${workspace}: ${beads[0].title}`.slice(0, 160);
  return `Create ${beads.length} beads in ${workspace}?`;
}
