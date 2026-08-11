/**
 * The four verdicts on a bead nobody has endorsed yet — and what each one costs.
 *
 * lib/endorse.js is the *hold*: an agent-filed bead arrives carrying `unendorsed` and
 * nothing may open a session on it. lib/filing.js is what puts a bead under that hold.
 * This file is the other end of the trade — the four things Adam can say about one,
 * server-side, so the phone (bc-3zo9.4) is a list of rows and four buttons rather than
 * a place where the decisions are also invented.
 *
 * They are deliberately different acts, and the difference is what each leaves behind:
 *
 * - **Endorse** — the marker comes off and the bead becomes ordinary work: the advocate
 *   queues it on the next tick and a session can be opened on it from that moment. This
 *   is the only verdict that changes what may be *worked*, so it is the only one that
 *   has to be idempotent — two taps on a slow train is one endorsement and no error
 *   card. It is also the only one that may be aimed at a bead that is not held, for the
 *   same reason: the second tap must land on something.
 * - **Revoke** — closed, with the reason on the close. Not deleted: what an agent found
 *   at 02:00 and what you thought of it are both worth having in three weeks, when the
 *   same thing gets filed again and the only useful question is whether it was looked at
 *   before. The marker stays on the closed bead so `bd list --label unendorsed` is still
 *   the honest history of the feature.
 * - **Adjust** — the ✎ of the proposal card, retargeted at a bead that already exists.
 *   Exactly the six fields `applyEdits` normalises (lib/proposal.js), through the same
 *   `normalizeBead` clamps, so a priority typed as "high" or a type bd has never heard
 *   of is dealt with here rather than half way through a `bd update`. **It keeps the
 *   marker** unless the same call endorses: rewriting a title is not the same act as
 *   saying the work should happen, and conflating them would mean every typo fix was an
 *   endorsement.
 * - **Ask for changes** — a comment and nothing else. The bead stays held, so the next
 *   session that touches it reads your objection instead of re-filing the same bead next
 *   week. Not a label: the queue can read the thread, and a second marker that had to be
 *   cleared by three of the four verdicts is a state machine nobody asked for.
 *
 * **Every verdict takes a list.** One id is a list of one, and the group case is the one
 * a busy week actually produces — six discoveries filed overnight, five of them fine.
 * So one bead's failure never loses the others: each is caught, each gets a row in the
 * result, and the caller is told what landed and what did not. Embedded Dolt is
 * single-writer and a `bd` write can lose a lock race (`Bd.run` retries, and then it is
 * a real error); a group endorse that dropped four beads because the second collided
 * would be worse than no group endorse at all.
 *
 * **Held is required, except to endorse.** Revoke, adjust and ask-for-changes refuse a
 * bead that is no longer held, because between the queue being drawn on the phone and a
 * thumb landing on it, the bead may have been endorsed on the laptop — and closing work
 * that was endorsed a minute ago, over a stale list, is the one outcome this whole
 * feature exists to prevent. Adjust is let through when the same call endorses, since
 * "adjust and endorse" twice is the same double-tap that endorse itself has to survive.
 */
import { UNENDORSED, isHeld, refusal, endorse } from './endorse.js';
import { FILED_LABEL } from './filing.js';
import { normalizeBead } from './proposal.js';

/** The four. Anything else on a request is a client bug, not a verdict. */
export const VERDICTS = ['endorse', 'revoke', 'adjust', 'changes'];

/**
 * What adjust may rewrite, and nothing else.
 *
 * The same six the proposal card's ✎ offers, because they are the fields a bead can be
 * *wrong* about in a way you would fix before agreeing to it. Notes and design are the
 * filing agent's provenance (lib/filing.js writes the whole of `notes`), and deps are
 * the trail back to the work that found it — rewriting either from a phone would erase
 * the record the endorsement queue is reading from.
 */
export const EDITABLE = ['title', 'type', 'priority', 'description', 'acceptance', 'labels'];

/**
 * Labels a verdict will not let you set or clear as ordinary labels.
 *
 * `unendorsed` is the hold and it moves only by endorsing; `agent-filed` is provenance
 * and it survives endorsement on purpose (lib/filing.js). Both would otherwise be
 * collateral of an adjust that set `labels: []` meaning "clear the two labels I can see
 * on the card".
 */
export const PROTECTED_LABELS = [UNENDORSED, FILED_LABEL];

/** How many beads one call may act on. A group tap is a handful; 500 is a mistake. */
export const MAX_IDS = 100;

/**
 * What a revoke's close reason starts with, and what it says when you typed nothing.
 *
 * The prefix is fixed so `bd list --status closed` reads as a class of thing rather
 * than as six differently-worded closes — this is the one place a bead is closed
 * *without* the work having happened, and that is worth being able to see at a glance.
 */
export const REVOKED_PREFIX = 'Revoked before endorsement';
export const REVOKED_REASON = `${REVOKED_PREFIX} — not work worth doing`;

const clean = (v) => String(v ?? '').trim();

/**
 * What a `bd --json` row calls the field an edit calls something shorter.
 *
 * Two of the six do not have the name you would guess: a row carries `issue_type` and
 * `acceptance_criteria`, and reading `issue.type` off one gets `undefined` — which is
 * not a crash, it is a comparison that never matches, so *every* adjust would write
 * every field and the thread would fill with "type ? → task". The flags on `bd update`
 * are the short names, which is why the two vocabularies exist at all.
 */
const ROW_FIELD = {
  title: 'title',
  type: 'issue_type',
  description: 'description',
  acceptance: 'acceptance_criteria',
};

/** A field off a bd row, by the edit's name for it — falling back to the short name. */
const valueOf = (issue, key) => clean(issue?.[ROW_FIELD[key]] ?? issue?.[key]);

/** `{ id }`, `{ ids: [...] }` or `{ ids: 'a,b' }` → a deduped list, in the order given. */
export function parseIds(body) {
  const raw = body?.ids ?? body?.id ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map(clean).filter(Boolean))];
}

/**
 * A patch, through the same clamps a proposed bead goes through — and only the keys it
 * actually names.
 *
 * `normalizeBead` fills every field with a default, which is right when it is building
 * a bead and wrong when it is describing a change: run over `{ priority: 3 }` it would
 * hand back an empty description too, and an adjust that quietly blanked the
 * description of a bead you were only re-prioritising is exactly the failure that makes
 * people stop using the ✎. So the normalised object is computed and then *narrowed* to
 * the keys that were asked for.
 *
 * **Blanking a text field is not an edit.** A cleared title is dropped because an
 * untitled bead is not a bead — the same call `applyEdits` makes, for the same reason —
 * and a cleared description or acceptance is dropped with it, on the grounds that a form
 * which arrives with an empty box is far more often a client that failed to load the
 * bead than a person who meant to erase the only account of what the work is. A bead
 * whose description you want gone is a bead you want revoked. Labels are the exception,
 * because an empty list of labels is a thing somebody can mean.
 */
export function normalizeEdits(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const asked = EDITABLE.filter((k) => patch[k] !== undefined && patch[k] !== null);
  if (!asked.length) return {};

  // normalizeBead refuses an untitled bead, so it is given one it will never be asked
  // for unless the patch carried a real title of its own.
  const title = clean(patch.title);
  const norm = normalizeBead({ ...patch, title: title || 'x' }) || {};

  const out = {};
  for (const key of asked) {
    if (key === 'title' && !title) continue;
    if ((key === 'description' || key === 'acceptance') && !clean(patch[key])) continue;
    if (key === 'labels') {
      out.labels = (norm.labels || []).filter((l) => !PROTECTED_LABELS.includes(l));
      continue;
    }
    out[key] = norm[key];
  }
  return out;
}

/**
 * Which of these edits would actually change the bead, and the `bd update` to do it.
 *
 * Computed against the row rather than applied blind, so an adjust that re-sends the
 * values already on the bead is no `bd` write at all — which is what makes a phone that
 * posts the whole form on every save cheap, and what keeps a bead's history free of a
 * dozen "updated" commits that changed nothing.
 *
 * Labels are a *replacement* set, minus the protected two: what the card shows is what
 * the bead has, so a label the card no longer lists is a label you removed. The removal
 * is expressed as `--remove-label` rather than `--set-labels` precisely so the two
 * protected ones cannot be caught by it.
 */
export function updateFor(issue, edits) {
  const update = {};
  const changed = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(edits, k);

  for (const key of ['title', 'type', 'description', 'acceptance']) {
    if (!has(key)) continue;
    if (clean(edits[key]) === valueOf(issue, key)) continue;
    update[key] = edits[key];
    changed.push(key);
  }
  if (has('priority') && Number(issue?.priority) !== Number(edits.priority)) {
    update.priority = edits.priority;
    changed.push('priority');
  }
  if (has('labels')) {
    const current = (issue?.labels || []).map((l) => clean(l)).filter(Boolean);
    const want = new Set(edits.labels);
    const addLabels = [...want].filter((l) => !current.includes(l));
    const removeLabels = current.filter((l) => !want.has(l) && !PROTECTED_LABELS.includes(l));
    if (addLabels.length) update.addLabels = addLabels;
    if (removeLabels.length) update.removeLabels = removeLabels;
    if (addLabels.length || removeLabels.length) changed.push('labels');
  }
  return { update, changed };
}

/**
 * One line for the thread saying what you rewrote, so the bead explains why it no
 * longer reads the way the agent filed it.
 *
 * Old → new for the short fields, names only for the long ones: a comment that quoted
 * two paragraphs of description back at itself would bury the change it was announcing,
 * and `bd` keeps the previous value anyway.
 */
export function changeSummary(issue, update) {
  const bits = [];
  if (update.title) bits.push(`title (was “${valueOf(issue, 'title')}”)`);
  if (update.type) bits.push(`type ${valueOf(issue, 'type') || '?'} → ${update.type}`);
  if (update.priority !== undefined) bits.push(`priority P${issue?.priority ?? '?'} → P${update.priority}`);
  if (update.description) bits.push('description');
  if (update.acceptance) bits.push('acceptance');
  if (update.addLabels || update.removeLabels) {
    const moved = [
      ...(update.addLabels || []).map((l) => `+${l}`),
      ...(update.removeLabels || []).map((l) => `−${l}`),
    ];
    bits.push(`labels (${moved.join(' ')})`);
  }
  return bits.length ? `_Adjusted before endorsement:_ ${bits.join(', ')}.` : '';
}

/** `bd show` for a bead that may not exist, as a 404 refusal rather than a 500. */
async function load(bd, ws, id) {
  let issue = null;
  try {
    issue = await bd.show(ws, id);
  } catch (err) {
    // bd 1.1.2 says "no issue found matching" here and "not found" elsewhere — the
    // same read /api/bead makes, and for the same reason: an id that is gone is a
    // thing you tapped, not a server that broke.
    if (!/no issues? found|not found/i.test(String(err?.message || ''))) throw err;
  }
  if (!issue) throw Object.assign(new Error(`no such bead: ${id}`), { status: 404 });
  return issue;
}

/** The refusal every verdict but endorse gives a bead that is no longer held. */
const notHeld = (id) =>
  refusal(id, `it is not ${UNENDORSED} — it has already been endorsed, so this is not a verdict on a proposal`);

/**
 * Endorse: the marker comes off and that is the whole of it.
 *
 * Idempotent by construction — `endorse` in lib/endorse.js reports `endorsed: false` and
 * does no write when the bead was never held — so a second tap is a 200 that says
 * nothing happened, which is the truth and not an error.
 */
async function endorseOne(bd, ws, id) {
  const issue = await load(bd, ws, id);
  const { endorsed } = await endorse(bd, ws, issue);
  return { id, verdict: 'endorse', ok: true, endorsed, title: clean(issue.title) };
}

/**
 * Revoke: closed with the reason, marker left on.
 *
 * A bead that is already closed is `revoked: false, already: true` rather than an
 * error — `bd close` on a closed issue is not a thing worth failing a group over, and
 * the second tap of a double-tap means the same as the first.
 */
async function revokeOne(bd, ws, id, { reason }) {
  const issue = await load(bd, ws, id);
  if (!isHeld(issue)) throw notHeld(id);
  if (clean(issue.status) === 'closed') {
    return { id, verdict: 'revoke', ok: true, revoked: false, already: true, title: clean(issue.title) };
  }
  await bd.close(ws, id, reason);
  return { id, verdict: 'revoke', ok: true, revoked: true, already: false, reason, title: clean(issue.title) };
}

/**
 * Adjust: rewrite the six fields, keep the hold — unless this call endorses too.
 *
 * The endorsement goes *after* the update, and only if the update landed. "Adjusted and
 * endorsed" is one decision made in one tap, and half of it is the wrong half to keep:
 * a bead endorsed with the title you were in the middle of fixing is workable, and one
 * adjusted but still held is simply still waiting for you.
 */
async function adjustOne(bd, ws, id, { edits, alsoEndorse, actor }) {
  const issue = await load(bd, ws, id);
  if (!isHeld(issue) && !alsoEndorse) throw notHeld(id);

  const { update, changed } = updateFor(issue, edits);
  if (changed.length) {
    await bd.update(ws, id, update);
    // The note is worth having and not worth failing over: the fields are already
    // rewritten, and losing the adjust to a comment that could not be written would
    // undo nothing and report a failure that did not happen.
    const summary = changeSummary(issue, update);
    if (summary) await bd.noteOnly(ws, id, summary, { actor }).catch(() => {});
  }
  const { endorsed } = alsoEndorse ? await endorse(bd, ws, id) : { endorsed: false };
  return { id, verdict: 'adjust', ok: true, changed, endorsed, title: clean(update.title || issue.title) };
}

/**
 * Ask for changes: your objection on the thread, the bead left exactly where it was.
 *
 * Written as you rather than as the daemon, because this one *is* a sentence somebody
 * said — the note in lib/bd.js `commission` draws that line, and the whole value of the
 * comment is that the next session reads it as a person's objection.
 */
async function changesOne(bd, ws, id, { note, actor }) {
  const issue = await load(bd, ws, id);
  if (!isHeld(issue)) throw notHeld(id);
  await bd.comment(ws, id, note, { actor });
  return { id, verdict: 'changes', ok: true, noted: true, title: clean(issue.title) };
}

/**
 * Run one verdict over one bead or a list of them, and report each outcome separately.
 *
 * Sequential rather than parallel on purpose: embedded Dolt is single-writer, so six
 * concurrent writes into one workspace is six lock races and a slower answer than doing
 * them in a row. The list is a handful of beads (`MAX_IDS`), and the caller is a thumb.
 *
 * Never throws for a bead. A `bd` that fell over on the third id leaves the first two
 * done, the third in `failed` with its reason, and the rest still attempted — which is
 * what makes retrying a group tap safe, since every verdict here is either idempotent
 * or reports that it had already happened.
 */
export async function applyVerdict(bd, ws, { verdict, ids, reason = '', note = '', edits = {}, endorse: alsoEndorse = false, actor = null } = {}) {
  const results = [];
  for (const id of ids || []) {
    try {
      if (verdict === 'endorse') results.push(await endorseOne(bd, ws, id));
      else if (verdict === 'revoke') results.push(await revokeOne(bd, ws, id, { reason: reason || REVOKED_REASON }));
      else if (verdict === 'adjust') results.push(await adjustOne(bd, ws, id, { edits, alsoEndorse, actor }));
      else if (verdict === 'changes') results.push(await changesOne(bd, ws, id, { note, actor }));
      else throw Object.assign(new Error(`${verdict} is not a verdict`), { status: 400 });
    } catch (err) {
      results.push({
        id,
        verdict,
        ok: false,
        status: Number(err?.status) || 500,
        unendorsed: Boolean(err?.unendorsed),
        error: String(err?.message || err).split('\n')[0],
      });
    }
  }
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return { verdict, results, ok, failed };
}

/**
 * What HTTP status a group deserves.
 *
 * Anything at all having worked is a 200 with the rows in it — a group of six where the
 * fifth lost a lock race is not a failed request, and a client that threw the whole
 * response away over it would show you five beads still sitting in the queue that are
 * not there any more. Only a call where *nothing* landed takes the failure's own status,
 * so the single-id case — which is most taps — still reads as a plain 404 or 409.
 */
export const statusFor = ({ ok, failed }) => (ok.length || !failed.length ? 200 : failed[0].status || 500);

/**
 * What goes on the wire — and `ok` is a boolean here, where it is a list inside.
 *
 * The two are different questions and they were briefly the same word: `applyVerdict`
 * means "the rows that worked", a client means `if (!res.ok)`. Spreading the one into
 * the other handed the phone an array where it expected a flag, which is true for an
 * empty group and false for nothing else — a bug that reads as working right up until
 * the day a verdict fails. So the shape is built here, once, rather than assembled at
 * four call sites.
 *
 * `applied` is the ids that moved, which is what a queue needs to take rows off the
 * screen; `results` is every bead in the order they were asked for, failures included,
 * which is what a card needs to say what went wrong with which.
 */
export const verdictBody = (out) => ({
  ok: out.failed.length === 0,
  verdict: out.verdict,
  results: out.results,
  applied: out.ok.map((r) => r.id),
  failed: out.failed,
});
