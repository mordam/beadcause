/**
 * `ran:<model>` — what a session on this bead **actually** ran on, once it has finished.
 *
 * The third part of bc-nc6o, and it exists because the first two record a *plan*.
 * lib/complexity.js turns the bead's tier into a `--model` at spawn time and the advocate
 * puts that on its card, but a selection made in the second before a window opens is not
 * the same fact as what the hour inside it was billed to. They come apart for at least
 * four ordinary reasons — somebody typed `/model` mid-session, an approved amendment beat
 * the tier, the CLI fell back, a config default moved under it — and a card showing only
 * the selection would go on saying `sonnet` about a session that spent the whole afternoon
 * on Opus. It would not look wrong, which is the problem: the number is plausible, nobody
 * has any other copy of it, and the first time the two diverge is the one time you would
 * have wanted to know.
 *
 * **Observed, not reported.** Nothing asks the session what it ran on — a session that
 * changed model mid-run and then crashed would never answer, and one that answered would
 * be answering about the moment it was asked. Claude Code writes every assistant turn to
 * `~/.claude/projects/<slug>/<session-id>.jsonl` with the model id on it, so the answer is
 * already on disk, per turn, whether or not the window is still there. `modelsInTranscript`
 * reads it back. A session that switched model halfway through therefore yields *two*
 * models and both are kept, because "it ran on opus" and "it started on sonnet and moved
 * to opus" are different sentences and only the second one explains the bill.
 *
 * **A label, and the same shape as `complexity:<tier>` for the same reasons** (see
 * lib/complexity.js): beads carries, syncs and filters on labels without beadcause owning
 * a schema, so `bd list --label ran:opus` is a question anybody can ask today, from any
 * machine on the workspace. It is also a *set*, which is exactly the shape of the fact —
 * a bead worked twice on two models keeps both labels, and a bead worked twice on the
 * same one grows nothing the second time. That is the acceptance on bc-nc6o.3 in one
 * sentence: an earlier run's model is never lost, and never re-stated.
 *
 * **The family, not the id.** `claude-opus-5` becomes `ran:opus`, in the same vocabulary
 * `MODEL_BY_TIER` routes with, so "did this run on what it was routed to" is a comparison
 * rather than a mapping — and so a bead worked in March and again in June does not sprout
 * two labels claiming a divergence that is really two point releases of one model. The
 * exact id is not thrown away: it goes into the session's own `meta.json` on
 * `refs/beadcause/sessions/<bead>`, which is where per-run precision belongs. The bead
 * carries the readable fact; the archive carries the forensic one.
 *
 * **An id naming no family we know is kept verbatim rather than dropped.** A future model
 * called something this file has never heard of is the one case where guessing loses the
 * whole point of recording anything, so it lands as `ran:<the-id>` and reads as odd, which
 * is correct: it *is* odd, and a blank would have been a lie.
 */

/** The label prefix. One spelling in one place, as `COMPLEXITY_PREFIX` is. */
export const RAN_PREFIX = 'ran:';

/**
 * The families a model id can belong to.
 *
 * Matched as a *word inside* the id rather than as a prefix or a suffix, because the two
 * shapes Anthropic has shipped put it in different places — `claude-opus-5` and
 * `claude-3-5-sonnet-20241022` — and a hosted id puts a whole vendor path in front of it
 * (`us.anthropic.claude-opus-4-20250514-v1:0`). Looking for the word covers all three
 * without a list of id formats to keep in step with the ones that actually exist.
 */
export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'];

/**
 * Assistant turns Claude Code writes with a model id that names no model.
 *
 * `<synthetic>` is what it stamps on messages it composed itself — an interrupt notice, a
 * cancelled turn, an error rendered as if the assistant had said it. Real, in a real
 * transcript, and on no real model: counting it would put `ran:-synthetic-` on the bead of
 * every session anybody ever pressed escape in.
 */
const NOT_A_MODEL = new Set(['<synthetic>', 'synthetic', '<none>', 'unknown']);

/** Anything a label may not carry, folded to `-`. Labels here are words, not sentences. */
const label = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A model id → `opus` | `sonnet` | `haiku`, or `''` for one this file cannot place.
 *
 * Takes an alias as happily as an id, because the two vocabularies meet here: the router
 * writes `opus` and the transcript writes `claude-opus-5`, and the whole reason this
 * function exists is that those two are the same answer.
 *
 * Matching by substring is why this is never asked to tell a `[1m]` selection from the
 * default window — `'claude-opus-5[1m]'.includes('opus')` is `true`, which is correct: the
 * bracket names a *window*, not a different family, and the two questions are answered by
 * two different functions. See `ranToken`'s `longWindow` option for the other one.
 */
export function modelFamily(model) {
  const id = String(model ?? '').trim().toLowerCase();
  if (!id || NOT_A_MODEL.has(id)) return '';
  return MODEL_FAMILIES.find((family) => id.includes(family)) || '';
}

/**
 * What goes after `ran:` for this model — the family where there is one, the id itself
 * where there is not, and `''` for something that names no model at all.
 *
 * `opts.longWindow` appends `-1m`. It is a caller-supplied fact rather than something
 * read off `model` itself, because the one place that fact actually lives — the `[1m]`
 * marker on the *selection* handed to `--model` — is exactly the thing a transcript never
 * repeats: Claude Code writes `message.model` as `claude-opus-5` whether the session
 * opened on the 200k window or the 1M one (see `contextWindow` in lib/sessiontokens.js,
 * which hits the identical wall and is why it also takes the window as an argument rather
 * than reading it off a turn). So a `[1m]` session and a 200k session on the same family
 * produce the same transcript id, and the only way this function can tell them apart is
 * to be told — by a caller that still has the selection in hand.
 */
export function ranToken(model, opts) {
  const id = String(model ?? '').trim().toLowerCase();
  if (!id || NOT_A_MODEL.has(id)) return '';
  const base = modelFamily(id) || label(id);
  return opts?.longWindow ? `${base}-1m` : base;
}

/**
 * `ran:opus`, or `ran:opus-1m` for `{ longWindow: true }`. `''` for a model this cannot
 * make a label out of — never `ran:`.
 */
export function ranLabel(model, opts) {
  const token = ranToken(model, opts);
  return token ? `${RAN_PREFIX}${token}` : '';
}

/** Is this one of ours? Used by the ✎ to leave it alone — see `isProtectedLabel`. */
export const isRanLabel = (value) => String(value ?? '').trim().toLowerCase().startsWith(RAN_PREFIX);

/** The `ran:` labels off a bead, as written. */
export const ranLabelsOf = (bead) =>
  (bead?.labels || []).map((l) => String(l).trim()).filter((l) => isRanLabel(l));

/**
 * Every model this bead has been worked on, deduplicated, in the order its labels list
 * them. `[]` for a bead nothing has finished a session on, which is most of the tracker.
 *
 * Deliberately **not** ordered by time. A label set has no order and pretending otherwise
 * would be inventing a fact; a caller that needs "which one was last" wants the session
 * archive, where the runs are a chain of commits and the question has a real answer.
 */
export function modelsRan(bead) {
  const out = [];
  for (const raw of ranLabelsOf(bead)) {
    const token = raw.slice(RAN_PREFIX.length).trim().toLowerCase();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The models an actual run used, read off its transcript: `['claude-opus-5']`, or two of
 * them for a session somebody moved mid-way, first seen first.
 *
 * Takes the file's text rather than its path, so the one part of this worth testing is
 * testable without a fake home directory — lib/sessionlog.js owns finding the files, and
 * already had to, since a session that enters a worktree writes under two project slugs.
 *
 * Only `assistant` events count. A transcript is full of other people's model names:
 * tool results quoting documentation, a `grep` for the word `model`, an agent reasoning
 * out loud about which one to use. Every one of those would match a regex over the raw
 * line, and one of them is this very file. So each line is parsed and the id is taken
 * from where Claude Code actually writes it, `message.model`, and nowhere else.
 */
export function modelsInTranscript(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A half-written last line is the normal state of a file being appended to.
      continue;
    }
    if (event?.type !== 'assistant') continue;
    const id = String(event?.message?.model ?? '').trim();
    if (!id || NOT_A_MODEL.has(id.toLowerCase())) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The labels this bead is missing for these models: `{ addLabels }`.
 *
 * Never removes. A `ran:` label is a thing that happened, and the only edit history can
 * take is another entry — which is also why re-archiving a session, or a second run on
 * the same model, is `{ addLabels: [] }` and therefore no `bd` call at all.
 *
 * `opts.longWindow` is one fact about the whole run, not one per model in `models` — a
 * session only ever opens on one selection, so every model it shows as having run on
 * (plain, or moved mid-run) shares the same window. The caller is lib/advocate.js's
 * `recordRun`, which already has this from the same `tokens` it uses for `ctx:`.
 */
export function ranUpdate(bead, models, opts) {
  const current = new Set(ranLabelsOf(bead).map((l) => l.toLowerCase()));
  const addLabels = [];
  for (const model of models || []) {
    const want = ranLabel(model, opts);
    if (!want || current.has(want) || addLabels.includes(want)) continue;
    addLabels.push(want);
  }
  return { addLabels };
}

/**
 * Did the run go somewhere other than where it was sent? `true` only when both halves are
 * known and they name different families.
 *
 * The unknown half is the common case and answers `false` on purpose: a session with no
 * transcript left, or a window opened by hand and never routed, has not diverged from
 * anything — it has simply not said. A card that drew "ran on something else" from a
 * missing fact would cry wolf on every hand-opened session there is.
 */
export function ranDiverged(routed, models) {
  const planned = modelFamily(routed) || ranToken(routed);
  if (!planned) return false;
  const ran = (models || []).map((m) => ranToken(m)).filter(Boolean);
  if (!ran.length) return false;
  return !ran.includes(planned);
}
