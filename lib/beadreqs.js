/**
 * What a bead says it fulfils — validated requirement ids, and candidates kept apart.
 *
 * The corpus (lib/requirements.js) is the vocabulary; this is where a bead speaks it. One
 * marked block in `notes`, holding two lists that are deliberately not one list.
 *
 * ## Why two shapes and not one
 *
 * **An id** resolves against the corpus. Somebody wrote that requirement down, in
 * `architecture`, and every edge recorded against it can be trusted to mean the same thing
 * to the next reader.
 *
 * **A candidate** is a requirement stated in an AC that has no id yet — which is the
 * ordinary case here rather than the exception, because requirements are recorded when a
 * ticket ships and beads are written before it starts. It carries a token, a proposed
 * name, the definition somebody would write, and where it came from.
 *
 * Storing them in one field is how a proposal becomes indistinguishable from a fact three
 * weeks later: both are strings that look like ids, and by the time anyone notices, the
 * graph has edges hanging off things nobody ever agreed to. lib/beadfiles.js already made
 * this argument about `declared` versus `guessed` and refused to merge them for the same
 * reason — the strength of a claim is most of what a reader does with it.
 *
 * ## Why the notes field, and why JSON inside it
 *
 * `notes` because bd has no field for this and the two candidates are both worse: `design`
 * belongs to whoever wrote the bead, and a `human` label would put the bead in the inbox
 * as a question, which it is not. Notes survive a claim, a reopen and a sync — the same
 * three facts lib/epicadvocate.js relies on for `waiting` and lib/plan.js for a plan, and
 * the marker convention here is theirs.
 *
 * JSON inside the markers rather than prose because a candidate has four fields and a
 * flattened sentence loses the one that matters — the token it belongs under, which is
 * what decides *which file* a promotion writes into (lib/reqpromote.js). lib/edits.js
 * keeps a JSON block in a bead for exactly this reason.
 *
 * ## Reading is where the refusal happens
 *
 * An id in the block that is not in the corpus is **dropped on read** and reported in
 * `dropped`, rather than dropped silently or kept and believed. Kept, it is a fabrication
 * with a bead's authority behind it. Dropped silently, an advocate writes the same wrong
 * id every run and nothing ever says why it keeps vanishing. So the caller is told, and
 * lib/epicadvocate.js puts it in the next brief — which is the only thing that has ever
 * stopped an agent repeating itself.
 *
 * A bead with no block returns two empty lists. That is not an error and never becomes
 * one: most beads in this tracker will never carry a requirement, and a reader that
 * treated absence as a fault would make the tracker broken for as long as that was true.
 */
import { isRequirement } from './requirements.js';

export const REQS_OPEN = '<!-- beadcause:requirements -->';
export const REQS_CLOSE = '<!-- /beadcause:requirements -->';

/** Bounds, for the same reason lib/beadfiles.js has them: this is text somebody pasted. */
const MAX_IDS = 24;
const MAX_CANDIDATES = 12;
const MAX_DEFINITION = 600;
const MAX_FROM = 300;

/** A requirement id, by shape alone — the corpus decides whether it is real. */
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+$/;

/** A candidate's name, which is what would follow the token if it were promoted. */
const NAME_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** One candidate, cleaned. Null when it is missing the two fields that make it usable. */
export function cleanCandidate(raw) {
  const token = str(raw?.token, 40);
  const name = str(raw?.name, 120);
  const definition = str(raw?.definition, MAX_DEFINITION);
  if (!token || !name || !NAME_SHAPE.test(name)) return null;
  // A candidate with no definition is a name somebody liked, and nothing can be promoted
  // from it — the whole point of the shape is that it is ready to become a requirement.
  if (!definition) return null;
  return {
    token,
    name,
    definition,
    from: str(raw?.from, MAX_FROM),
    at: str(raw?.at, 40),
  };
}

/** What a candidate would be called if it were promoted. Not an id until it is. */
export const candidateId = (c) => (c?.token && c?.name ? `${c.token}.${c.name}` : '');

/**
 * The block, as it goes into `notes`.
 *
 * Empty in, empty out — an empty block would be a claim ("this bead has been looked at
 * and fulfils nothing") made by whichever code path happened to run, and the honest
 * absence is no block at all. Same decision `waitingBlock` makes in lib/epicadvocate.js.
 */
export function requirementsBlock({ ids = [], candidates = [] } = {}) {
  const cleanIds = [];
  for (const id of ids) {
    const v = str(id, 200);
    if (v && ID_SHAPE.test(v) && !cleanIds.includes(v)) cleanIds.push(v);
    if (cleanIds.length >= MAX_IDS) break;
  }
  const cleanCandidates = [];
  for (const raw of candidates) {
    const c = cleanCandidate(raw);
    if (c && !cleanCandidates.some((x) => candidateId(x) === candidateId(c))) cleanCandidates.push(c);
    if (cleanCandidates.length >= MAX_CANDIDATES) break;
  }
  if (!cleanIds.length && !cleanCandidates.length) return '';
  const payload = JSON.stringify({ ids: cleanIds, candidates: cleanCandidates }, null, 2);
  return `${REQS_OPEN}\n\`\`\`json\n${payload}\n\`\`\`\n${REQS_CLOSE}`;
}

/** The raw text between the markers, or ''. */
function blockBody(notes) {
  const text = String(notes || '');
  const from = text.indexOf(REQS_OPEN);
  if (from < 0) return '';
  const to = text.indexOf(REQS_CLOSE, from);
  const inner = to < 0 ? text.slice(from + REQS_OPEN.length) : text.slice(from + REQS_OPEN.length, to);
  return inner.replace(/```(?:json)?/g, '').trim();
}

/**
 * What this bead says it fulfils, with anything the corpus does not recognise held back.
 *
 * `{ ids, candidates, dropped }`. `dropped` is the ids that were written down and are not
 * requirements — the field that lets the next brief say "you wrote this and it does not
 * exist" instead of quietly discarding it again.
 *
 * Reading with no corpus (a Mac without the architecture checkout) drops **nothing**: with
 * no vocabulary to check against, refusing every id would turn a missing checkout into
 * data loss on the next write. Absent evidence is not evidence of absence, and this is the
 * one place where getting that backwards costs something irreversible.
 */
export function readRequirements(issue, corpus = null) {
  const body = blockBody(issue?.notes);
  if (!body) return { ids: [], candidates: [], dropped: [] };

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A block somebody hand-edited into invalid JSON is not a crash and not a licence to
    // guess: the ids in it are still readable by shape, and the candidates are not.
    const ids = [...body.matchAll(/"([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)"/g)].map((m) => m[1]);
    parsed = { ids, candidates: [] };
  }

  const ids = [];
  const dropped = [];
  const known = Boolean(corpus?.ids?.size);
  for (const raw of Array.isArray(parsed?.ids) ? parsed.ids : []) {
    const id = str(raw, 200);
    if (!id || !ID_SHAPE.test(id)) continue;
    if (ids.includes(id) || dropped.includes(id)) continue;
    if (!known || isRequirement(corpus, id)) ids.push(id);
    else dropped.push(id);
    if (ids.length >= MAX_IDS) break;
  }

  const candidates = [];
  for (const raw of Array.isArray(parsed?.candidates) ? parsed.candidates : []) {
    const c = cleanCandidate(raw);
    if (!c) continue;
    // A candidate that has since been promoted is an id, and saying it twice would leave
    // the bead proposing something that already exists.
    if (known && isRequirement(corpus, candidateId(c))) {
      if (!ids.includes(candidateId(c)) && ids.length < MAX_IDS) ids.push(candidateId(c));
      continue;
    }
    if (!candidates.some((x) => candidateId(x) === candidateId(c))) candidates.push(c);
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return { ids, candidates, dropped };
}

/**
 * `notes` with the block replaced, added, or removed.
 *
 * Replacing rather than appending is the whole of it: a block that accretes is a bead
 * carrying four generations of what an advocate used to think, and the newest is not
 * distinguishable from the oldest without reading all four. The rest of the notes — which
 * is somebody's prose — is preserved exactly, which is why this splices rather than
 * rewrites.
 */
export function withRequirements(notes, payload) {
  const text = String(notes || '');
  const block = requirementsBlock(payload || {});
  const from = text.indexOf(REQS_OPEN);
  if (from < 0) return block ? `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}` : text;
  const to = text.indexOf(REQS_CLOSE, from);
  const head = text.slice(0, from).trimEnd();
  const tail = to < 0 ? '' : text.slice(to + REQS_CLOSE.length).trimStart();
  return [head, block, tail].filter(Boolean).join('\n\n');
}

/** Does this bead say anything about requirements at all? What the glean pass asks. */
export const hasRequirements = (issue) => {
  const { ids, candidates } = readRequirements(issue, null);
  return Boolean(ids.length || candidates.length);
};
