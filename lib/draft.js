import YAML from 'yaml';

/**
 * The `beads` block — what the chat session's agent proposes, before anything is created.
 *
 * Not to be confused with its sibling `lib/proposal.js`, which parses the
 * `beadproposal` block an *advocate* files when a queue runs dry. Both turn YAML
 * into beads-to-be, and they are deliberately separate: an advocate's proposal is a
 * one-shot question you approve or don't, while a chat session's draft is edited on screen
 * over several turns and therefore carries the things editing needs — a stable
 * `ref` per card, parents, and dependencies between beads that do not exist yet.
 * Folding them together would mean one schema serving two different lifecycles.
 *
 * beads has no "draft issue" concept, and the whole point of the chat session is that
 * nothing reaches the tracker until you have read it and edited it. So the agent
 * writes its proposal into its own reply as a fenced block, exactly the way an
 * agent writes a `decision` block into an issue body (see lib/decision.js), and
 * beadcause parses it into something the phone can render as editable cards:
 *
 *   ```beads
 *   beads:
 *     - ref: retry-client            # a handle, only meaningful inside this block
 *       title: Give the DMS client a retry policy
 *       type: task                   # task | bug | feature | epic | chore
 *       priority: 1                  # 0 critical … 4 backlog
 *       description: |
 *         Why this exists and what needs doing.
 *       acceptance: |
 *         How we know it is done.
 *       labels: [api]
 *     - ref: retry-tests
 *       title: Cover the retry policy
 *       dependsOn: [retry-client]    # a ref above, or a real id like cl-1jw
 *       parent: retry-client
 *   ```
 *
 * Two properties matter, and both come from the block being *whole*:
 *
 * 1. **It replaces, never appends.** Each proposal is the complete current answer,
 *    so a conversation that revises the third bead re-emits all four. Merging
 *    partial proposals across turns would mean reconstructing what the agent meant
 *    from a diff it never wrote.
 * 2. **`ref` is not an id.** Nothing exists yet, so dependencies and parents inside
 *    a proposal point at refs; they are resolved to real ids at creation time, in
 *    dependency order. A ref that looks like an existing bead id and isn't in the
 *    proposal is passed through as an external id instead — that is how "this new
 *    work depends on the bead we started from" is expressed.
 */

/** Global: a revised proposal is a *later* block, and the last one is the live one. */
const BLOCK_RE = /(^|\n)(?:```|~~~)[ \t]*beads[ \t]*\r?\n([\s\S]*?)(?:```|~~~)[ \t]*(?=\r?\n|$)/g;

export const TYPES = ['task', 'bug', 'feature', 'epic', 'chore'];

/**
 * What a bead id looks like: `cl-1jw`, `bc-7rx`, `sp-hz3`.
 *
 * Only a shape check, and deliberately a loose one — a slug and an id are not
 * reliably distinguishable (`bc-yzx` is a real id and carries no digit, so no
 * "must contain a number" rule is available). It exists to keep an obvious
 * sentence fragment out of the dependency list; whether a well-shaped id actually
 * exists is settled against the tracker at creation time, where the answer is
 * authoritative rather than guessed.
 */
export const ID_RE = /^[a-z]{1,5}-[a-z0-9]{2,8}$/i;

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

const str = (v) => (v == null ? '' : String(v).trim());

const asList = (raw) =>
  (Array.isArray(raw) ? raw : raw ? [raw] : []).map((s) => str(s)).filter(Boolean);

/**
 * Labels, exactly as written — the one list in a draft that is **not** slugged.
 *
 * Everything else on a card that goes through `slug` is an *identifier this file
 * invents*: a `ref` is the editor's handle for a bead that does not exist yet, and
 * `parent`/`dependsOn` point at one. Lowercasing those and joining them with dashes is
 * how two spellings of the same intention become the same edge.
 *
 * A label is the opposite: it is a value the tracker already owns, and half of the ones
 * that matter here are structured — `owner:adam@example.com` (lib/ownership.js),
 * `held:<stamp>:<handle>` (lib/lease.js), `superseded-by:<id>` (lib/superseded.js). Every
 * one of them is read back by a parser that splits on the colon, so slugging is not a
 * tidy-up: it destroys the label and leaves a lookalike that no query matches. bc-vriu.1
 * is what that cost — twelve beads filed carrying `owner-neadamthal-gmail-com` *beside*
 * the real `owner:neadamthal@gmail.com`, because `Bd.create` could not see an owner on
 * the way in and stamped one, and every child created under those epics inherited the
 * pair. Two labels meaning one fact, on a board where who is answerable is a label query.
 *
 * So this is `lib/proposal.js`'s normalisation and no more — trim, drop the empties —
 * with one addition: a comma splits. The editor's Labels field is one comma-separated
 * input and the agent writes `labels: api, tracker` about as often as it writes a list,
 * and `bd create --label 'a,b'` splits on the comma itself, so a label containing one
 * cannot survive to the tracker whatever this does. Splitting here means the card shows
 * what will actually be filed.
 */
const labelList = (raw) =>
  asList(raw)
    .flatMap((l) => l.split(','))
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Priority as bd means it: 0–4, where 0 is critical.
 *
 * `P1` and `high` both turn up — the first because that is how bd prints it, the
 * second because it is how everyone says it out loud — and bd rejects both. A value
 * that means nothing here becomes the default rather than an error, since a
 * mistyped priority is not worth refusing a whole proposal over.
 */
export function normalizePriority(raw, fallback = 2) {
  if (raw == null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  const named = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3, backlog: 4 };
  if (named[s] != null) return named[s];
  const n = Number(s.replace(/^p/, ''));
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : fallback;
}

function normalizeType(raw) {
  const s = str(raw).toLowerCase();
  if (TYPES.includes(s)) return s;
  // The obvious near-misses, rather than silently filing a bug as a task.
  if (s === 'story' || s === 'enhancement') return 'feature';
  if (s === 'defect') return 'bug';
  return 'task';
}

/**
 * One bead, with every field the editor can show and `bd create` can set.
 *
 * `ref` is stabilised here rather than left to the agent: the editor uses it as the
 * card's identity across re-renders and as the value in the depends-on chips, so a
 * missing or duplicated ref would make two cards indistinguishable.
 */
function normalizeBead(raw, index, taken) {
  if (raw == null) return null;
  const o = typeof raw === 'string' ? { title: raw } : raw;
  const title = str(o.title ?? o.summary ?? o.name);
  if (!title) return null;

  let ref = slug(o.ref ?? o.key ?? o.id ?? title) || `bead-${index + 1}`;
  while (taken.has(ref)) ref = `${ref}-${index + 1}`;
  taken.add(ref);

  return {
    ref,
    title: title.slice(0, 200),
    type: normalizeType(o.type ?? o.issue_type ?? o.kind),
    priority: normalizePriority(o.priority ?? o.p),
    description: str(o.description ?? o.body ?? o.detail),
    acceptance: str(o.acceptance ?? o.acceptanceCriteria ?? o.acceptance_criteria),
    design: str(o.design),
    notes: str(o.notes),
    labels: labelList(o.labels ?? o.label),
    parent: slug(o.parent ?? o.parentRef ?? o.parent_ref) || null,
    dependsOn: asList(o.dependsOn ?? o.depends_on ?? o.deps ?? o.blockedBy ?? o.blocked_by).map((d) => slug(d)),
  };
}

/**
 * Make the graph inside a proposal safe to create from.
 *
 * Everything here is repaired rather than rejected. A proposal is a conversation's
 * output, not an API payload — dropping the whole thing because the agent pointed a
 * dependency at a bead it renamed two turns ago would throw away four good beads to
 * punish one bad edge. What cannot be repaired is reported alongside, so the editor
 * can say so on the card.
 */
export function validateDraft(draft) {
  const beads = draft?.beads || [];
  const refs = new Set(beads.map((b) => b.ref));
  const warnings = [];

  for (const b of beads) {
    // A ref that is neither in this proposal nor shaped like a real bead id points
    // at nothing at all, and would fail at `bd dep add` time with a worse message.
    b.dependsOn = b.dependsOn.filter((d) => {
      if (d === b.ref) return false;
      if (refs.has(d) || ID_RE.test(d)) return true;
      warnings.push(`${b.ref}: dropped dependency on "${d}" — no such bead in this proposal`);
      return false;
    });
    if (b.parent && !refs.has(b.parent) && !ID_RE.test(b.parent)) {
      warnings.push(`${b.ref}: dropped parent "${b.parent}" — no such bead in this proposal`);
      b.parent = null;
    }
    if (b.parent === b.ref) b.parent = null;
    // A child already waits on its parent through the hierarchy, and bd refuses the
    // explicit edge outright: "adding an explicit dependency would create a
    // deadlock". Saying both is the obvious way to write "this comes after that",
    // so it is dropped quietly here rather than warned about — it is redundant,
    // not wrong, and it used to fail the whole create half way through.
    if (b.parent) b.dependsOn = b.dependsOn.filter((d) => d !== b.parent);
  }

  // A cycle cannot be created in any order, so it is the one thing that has to be
  // broken rather than reported: creation would otherwise stall on a bead whose
  // dependency is still waiting for it.
  const order = topoOrder(beads);
  for (const ref of order.cycles) {
    const b = beads.find((x) => x.ref === ref);
    if (!b) continue;
    warnings.push(`${b.ref}: dropped dependencies that formed a cycle`);
    b.dependsOn = b.dependsOn.filter((d) => !refs.has(d));
    if (b.parent && refs.has(b.parent)) b.parent = null;
  }

  return { beads, warnings, order: order.cycles.length ? topoOrder(beads).refs : order.refs };
}

/**
 * Creation order: a bead's parent and its in-proposal dependencies first.
 *
 * Kahn's algorithm over refs only — external ids already exist, so they impose no
 * ordering. Anything left over is in a cycle and comes back in `cycles`.
 */
export function topoOrder(beads) {
  const refs = new Set(beads.map((b) => b.ref));
  const needs = new Map(
    beads.map((b) => [b.ref, new Set([...b.dependsOn, b.parent].filter((d) => d && refs.has(d) && d !== b.ref))])
  );
  const done = new Set();
  const out = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const b of beads) {
      if (done.has(b.ref)) continue;
      if ([...needs.get(b.ref)].every((d) => done.has(d))) {
        done.add(b.ref);
        out.push(b.ref);
        moved = true;
      }
    }
  }
  return { refs: out, cycles: beads.map((b) => b.ref).filter((r) => !done.has(r)) };
}

/**
 * Pull the proposal out of an agent reply.
 *
 * Returns the reply with the block removed — the chat shows prose, the draft panel
 * shows the beads, and raw YAML in a message bubble on a phone is unreadable noise.
 * A block that does not parse is reported instead of silently ignored: an invisible
 * proposal looks exactly like an agent that forgot to make one.
 */
export function extractProposal(text) {
  const src = String(text || '');
  const matches = [...src.matchAll(BLOCK_RE)];
  if (!matches.length) return { text: src.trim(), draft: null, raw: null, error: null };

  const m = matches[matches.length - 1];
  const stripped = (src.slice(0, m.index) + '\n' + src.slice(m.index + m[0].length)).trim();

  let spec;
  try {
    spec = YAML.parse(m[2]);
  } catch (err) {
    return {
      text: stripped,
      draft: null,
      raw: m[2],
      error: `beads block is not valid YAML: ${err.message.split('\n')[0]}`,
    };
  }

  const rows = Array.isArray(spec) ? spec : spec?.beads ?? spec?.issues ?? (spec?.title ? [spec] : []);
  const taken = new Set();
  const beads = (Array.isArray(rows) ? rows : []).map((r, i) => normalizeBead(r, i, taken)).filter(Boolean);
  if (!beads.length) {
    return { text: stripped, draft: null, raw: m[2], error: 'beads block had no beads with a title' };
  }

  const { warnings } = validateDraft({ beads });
  return { text: stripped, draft: { beads, summary: str(spec?.summary), warnings }, raw: m[2], error: null };
}

/**
 * The draft, back as YAML.
 *
 * Fed to the agent at the start of the next turn whenever you have edited the cards,
 * so it argues with what is on your screen rather than with what it last said. Two
 * turns in a row proposing a title you had already rewritten is the failure this
 * avoids.
 */
export function draftToYaml(draft) {
  const beads = (draft?.beads || []).map((b) => {
    const o = { ref: b.ref, title: b.title, type: b.type, priority: b.priority };
    if (b.description) o.description = b.description;
    if (b.acceptance) o.acceptance = b.acceptance;
    if (b.design) o.design = b.design;
    if (b.notes) o.notes = b.notes;
    if (b.labels?.length) o.labels = b.labels;
    if (b.parent) o.parent = b.parent;
    if (b.dependsOn?.length) o.dependsOn = b.dependsOn;
    return o;
  });
  return YAML.stringify({ beads }, { lineWidth: 0 });
}

/** Accept a draft edited on the phone: same normalisation, so the editor can't widen the schema. */
export function normalizeDraft(raw) {
  const rows = Array.isArray(raw?.beads) ? raw.beads : [];
  const taken = new Set();
  const beads = rows.map((r, i) => normalizeBead(r, i, taken)).filter(Boolean);
  if (!beads.length) return null;
  const { warnings } = validateDraft({ beads });
  return { beads, summary: str(raw?.summary), warnings };
}
