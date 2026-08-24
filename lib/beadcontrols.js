/**
 * What a bead says it exercises — validated control ids, in a marked block in `notes`.
 *
 * lib/beadreqs.js is the sibling and the model: one block, one list, and an id that does
 * not resolve is **dropped on read and reported**, never stored and believed. What is
 * written here is a *claim* — this bead's work exercises this control — and a claim is only
 * worth keeping if the next reader can trust that the id means what the standard says.
 *
 * ## One list, not two — and that is the whole difference from lib/beadreqs.js
 *
 * A requirement block carries **ids and candidates** because Climative's requirements are
 * written down when a ticket ships: most beads name something real that has no id yet, so
 * the shape has to hold a proposal without letting it pass for a fact.
 *
 * A control cannot be proposed. `SOC2.CC6.1` and `ISO42001.A.6.2.8` are published by the
 * AICPA and ISO, the corpus in lib/controls.js ships with beadcause rather than being
 * loaded from a checkout that may be absent, and nothing an agent writes can mint a
 * sixty-second criterion. So there is no candidate list and no promotion path, and the
 * absence is deliberate rather than unfinished: a "candidate control" would be an invented
 * control with a queue behind it, which is the one failure lib/controls.js exists to
 * prevent.
 *
 * That also removes the one hedge lib/beadreqs.js has to make. It refuses to drop anything
 * when the corpus is missing, because a Mac without the architecture checkout would
 * otherwise turn a missing directory into data loss. There is no such state here — an
 * absent control corpus is a broken build, not an install without one — so an id is
 * checked every time, on every machine, with no branch that lets an unchecked one through.
 *
 * ## Why `notes`, and why JSON
 *
 * lib/beadreqs.js's argument, unchanged and worth not re-deriving: `design` belongs to
 * whoever wrote the bead, a `human` label would put it in the inbox as a question it is
 * not, and notes survive a claim, a reopen and a sync. JSON inside the markers because the
 * block is written and rewritten by agents, and a list of ids in prose is a list somebody
 * reflows.
 *
 * A bead may carry this block and lib/beadreqs.js's at once — they are different markers
 * over different vocabularies, and `withControls` splices around whatever else is in the
 * notes rather than rewriting them.
 *
 * ## A bead with no block is the ordinary case
 *
 * Empty lists, no error, forever. Most beads in this tracker exercise no control any
 * standard has heard of, and a reader that treated absence as a fault would make the
 * tracker broken for as long as that was true. What the absence costs is visible in one
 * place and stated as a number rather than guessed at: `unevidenced` in
 * lib/controlcoverage.js, which is every control nothing has ever claimed.
 */
import { keepControls } from './controls.js';

export const CONTROLS_OPEN = '<!-- beadcause:controls -->';
export const CONTROLS_CLOSE = '<!-- /beadcause:controls -->';

/** Bounds, for lib/beadreqs.js's reason: this is text somebody or something pasted. */
const MAX_IDS = 24;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The block, as it goes into `notes`.
 *
 * Empty in, empty out. An empty block is a claim — "this bead has been looked at and
 * exercises nothing" — made by whichever code path happened to run, and the honest absence
 * is no block at all. `requirementsBlock` and `waitingBlock` make the same decision.
 *
 * Ids are cleaned and de-duplicated but **not** resolved here. Writing is where a caller
 * says what it believes; reading is where the corpus gets a veto. Putting the veto in both
 * places would mean a control the corpus later renamed could silently empty a bead nobody
 * edited, with no `dropped` list anywhere to say it had happened.
 */
export function controlsBlock({ ids = [] } = {}) {
  const clean = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = str(raw, 200);
    if (id && !clean.includes(id)) clean.push(id);
    if (clean.length >= MAX_IDS) break;
  }
  if (!clean.length) return '';
  const payload = JSON.stringify({ ids: clean }, null, 2);
  return `${CONTROLS_OPEN}\n\`\`\`json\n${payload}\n\`\`\`\n${CONTROLS_CLOSE}`;
}

/** The raw text between the markers, or ''. */
function blockBody(notes) {
  const text = String(notes || '');
  const from = text.indexOf(CONTROLS_OPEN);
  if (from < 0) return '';
  const to = text.indexOf(CONTROLS_CLOSE, from);
  const inner =
    to < 0 ? text.slice(from + CONTROLS_OPEN.length) : text.slice(from + CONTROLS_OPEN.length, to);
  return inner.replace(/```(?:json)?/g, '').trim();
}

/**
 * What this bead says it exercises — `{ ids, dropped }`.
 *
 * `dropped` is the ids that were written down and are not controls. It is the field that
 * lets the next brief say "you wrote this and it does not exist" instead of quietly
 * discarding it again, which is the only thing that has ever stopped an agent repeating
 * itself. lib/controls.js's `keepControls` is what decides, so the corpus is the single
 * authority and this file holds no opinion about what a control id looks like.
 *
 * A block somebody hand-edited into invalid JSON is not a crash and not a licence to
 * guess: the ids in it are still recoverable by shape, so they are read out and put
 * through the same corpus check as any others.
 */
export function readControls(issue) {
  const body = blockBody(issue?.notes);
  if (!body) return { ids: [], dropped: [] };

  let list = null;
  try {
    const parsed = JSON.parse(body);
    list = Array.isArray(parsed?.ids) ? parsed.ids : [];
  } catch {
    list = [...body.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+)"/g)].map((m) => m[1]);
  }

  const { ids, dropped } = keepControls(list.map((v) => str(v, 200)).filter(Boolean));
  return { ids: ids.slice(0, MAX_IDS), dropped };
}

/**
 * `notes` with the block replaced, added, or removed.
 *
 * Replacing rather than appending is the whole of it: a block that accretes is a bead
 * carrying four generations of what an agent used to think, and the newest is not
 * distinguishable from the oldest without reading all four. The rest of the notes — which
 * is somebody's prose, and may hold lib/beadreqs.js's block too — is preserved exactly,
 * which is why this splices rather than rewrites.
 */
export function withControls(notes, payload) {
  const text = String(notes || '');
  const block = controlsBlock(payload || {});
  const from = text.indexOf(CONTROLS_OPEN);
  if (from < 0) return block ? `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}` : text;
  const to = text.indexOf(CONTROLS_CLOSE, from);
  const head = text.slice(0, from).trimEnd();
  const tail = to < 0 ? '' : text.slice(to + CONTROLS_CLOSE.length).trimStart();
  return [head, block, tail].filter(Boolean).join('\n\n');
}

/** Does this bead claim a control at all? */
export const hasControls = (issue) => readControls(issue).ids.length > 0;
