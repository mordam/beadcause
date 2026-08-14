/**
 * `complexity:low|medium|high` — how hard a bead is, decided when it is filed.
 *
 * Most beadcause work is low to medium and does not need the expensive model; the
 * handful that do should not be run on the cheap one. bc-nc6o is the epic that turns
 * that into a routing decision, and this file is the first half of it: the tier is a
 * property **of the bead**, written at filing time by whoever wrote the bead, rather
 * than something the dispatcher guesses from a title three days later. A guess made at
 * spawn time has none of the context that made the answer obvious — the proposing agent
 * had just read the files, and the person who endorsed it had just read the proposal —
 * and it is a guess that has to be re-made, identically, every time the bead is opened.
 *
 * **A label, and deliberately the same shape as `repo:<token>` in lib/repos.js.** It is
 * the only per-bead thing beads itself will carry, sync and filter on without beadcause
 * owning a schema: `bd create --label complexity:high`, `bd label add bc-9f2
 * complexity:low` and `bd list --label complexity:high` all work today and go through
 * Dolt to every other machine on the workspace. The alternative — a line in the
 * description that beadcause parses — is prose, and prose is what this whole epic exists
 * to stop relying on.
 *
 * **No tier is a legal answer, and stays one.** Every bead created by hand, ingested
 * from JIRA, or filed before this landed carries none, and that is most of the tracker.
 * `beadComplexity` answers `{ tier: '', problem: null }` for those — a real answer, not
 * an error — and the routing half (bc-nc6o.2) falls back to the *expensive* model for
 * it, because an unrated bead is an unknown bead and the cheap failure mode of that
 * fallback is a bill rather than a botched session.
 *
 * **Two different tiers on one bead is refused rather than picked between**, exactly as
 * two `repo:` labels are. Taking the first would route by whichever label sorted first,
 * which is a coin toss dressed up as a decision; two labels naming the *same* tier is
 * not a conflict, it is one answer written twice.
 */

/**
 * The label prefix. One spelling in one place — the same decision, for the same reason,
 * as `REPO_PREFIX` in lib/repos.js and `SUPERSEDE_PREFIX` in lib/superseded.js.
 */
export const COMPLEXITY_PREFIX = 'complexity:';

/**
 * The vocabulary, cheapest first.
 *
 * Three and not five: the tier exists to pick between two models, so a scale finer than
 * the thing it decides would be precision nobody could act on. `medium` is here as the
 * ordinary case rather than as a middle — most beads are one, and a two-word vocabulary
 * would have made every unremarkable bead an explicit claim that it was easy.
 */
export const TIERS = ['low', 'medium', 'high'];

/** `complexity:high`. What a bead carries, and what the dispatcher reads back. */
export const complexityLabel = (tier) => `${COMPLEXITY_PREFIX}${String(tier || '').trim().toLowerCase()}`;

/**
 * A tier as somebody typed it → one of `TIERS`, or `''` for anything else.
 *
 * Unknown values are dropped rather than defaulted to a tier, and that direction is the
 * point: a proposal that says `complexity: medium-high` has said something nobody can
 * route on, and inventing `medium` from it would hide the typo behind a plausible
 * answer. `''` is a bead with no tier, which is a state everything downstream already
 * has to handle for the whole of the tracker that predates this.
 */
export function normalizeTier(value) {
  const tier = String(value ?? '').trim().toLowerCase();
  return TIERS.includes(tier) ? tier : '';
}

/** `['complexity:high']`, or `[]` for a bead that names no tier. Spread into labels. */
export const complexityLabels = (tier) => {
  const t = normalizeTier(tier);
  return t ? [complexityLabel(t)] : [];
};

/** The `complexity:` labels off a bead, and nothing else. */
export const complexityLabelsOf = (bead) =>
  (bead?.labels || []).map((l) => String(l).trim()).filter((l) => l.toLowerCase().startsWith(COMPLEXITY_PREFIX));

/**
 * The tier a bead names, or why it names none usable.
 *
 * Takes a `bd --json` row, anything carrying `labels`, or a bare tier string — the last
 * because a caller that already knows the tier (a test, a route with the tier on it)
 * should not have to build a fake bead to ask.
 *
 * Returns `{ tier, problem }`, the same shape `beadToken` answers in, so a caller can
 * check `problem` once and print it. All three of the not-a-tier answers are deliberate:
 *
 *   - **no `complexity:` label at all** — `{ tier: '', problem: null }`, which is a real
 *     answer and by far the commonest one: that bead is unrated, and the router takes
 *     the expensive fallback.
 *   - **two different `complexity:` labels** — `{ tier: null, problem: … }`. Somebody
 *     labelled it twice, or a sweep did; picking one would route by label order.
 *   - **a bare `complexity:`, or a word that is not a tier** — also a `problem`, and not
 *     "no tier". Somebody typed that label meaning something by it, and silently
 *     treating it as unrated would make a typo indistinguishable from a bead nobody had
 *     rated at all — which is the one case that is *supposed* to be invisible.
 */
export function beadComplexity(bead) {
  if (!bead) return { tier: '', problem: null };
  if (typeof bead === 'string') {
    const tier = bead.trim();
    if (!tier) return { tier: '', problem: null };
    return normalizeTier(tier)
      ? { tier: normalizeTier(tier), problem: null }
      : { tier: null, problem: `"${tier}" is not a complexity tier — expected one of ${TIERS.join(', ')}` };
  }

  const found = [];
  const bad = [];
  for (const raw of complexityLabelsOf(bead)) {
    const tier = normalizeTier(raw.slice(COMPLEXITY_PREFIX.length));
    if (!tier) {
      bad.push(raw);
      continue;
    }
    if (!found.includes(tier)) found.push(tier);
  }

  if (found.length > 1) {
    return {
      tier: null,
      problem: `carries ${found.length} complexity tiers (${found.map(complexityLabel).join(', ')}) — beadcause will not guess between them, take the wrong one off`,
    };
  }
  if (found.length === 1) return { tier: found[0], problem: null };
  if (bad.length) {
    return {
      tier: null,
      problem: `carries "${bad[0]}", which names no tier — expected one of ${TIERS.map(complexityLabel).join(', ')}`,
    };
  }
  return { tier: '', problem: null };
}

/**
 * Pull the tier out of a list of labels: `{ labels, tier }`.
 *
 * For the one caller that is *building* a bead rather than reading one —
 * `normalizeBead` in lib/proposal.js. An agent may write the tier as a field
 * (`complexity: high`) or as a label (`labels: [complexity:high]`), and both mean the
 * same thing; carrying it in two places would mean two things to keep in step and two
 * ways for a card to disagree with the bead it filed. So the labels are read once, here,
 * and the tier lives on its own field from then on.
 *
 * A list naming two different tiers loses both, and the bead is filed unrated. That is
 * the one place this file does not refuse: nothing has been created yet, the proposal
 * card shows what it will file, and an unrated bead routes to the expensive model — so
 * the cost of the ambiguity is a bill, where refusing would be a discovery dropped.
 */
export function splitComplexity(labels, tier = '') {
  const kept = [];
  const found = [];
  for (const raw of labels || []) {
    const label = String(raw).trim();
    if (!label.toLowerCase().startsWith(COMPLEXITY_PREFIX)) {
      if (label) kept.push(label);
      continue;
    }
    const t = normalizeTier(label.slice(COMPLEXITY_PREFIX.length));
    if (t && !found.includes(t)) found.push(t);
  }
  const named = normalizeTier(tier);
  return { labels: kept, tier: named || (found.length === 1 ? found[0] : '') };
}

/* --------------------------------------------------------------- routing on it */

/**
 * Tier → model. **The whole of the routing decision, and the only copy of it.**
 *
 * bc-nc6o.2, the other half of this file: everything above is a fact about the bead, and
 * this is the one place that fact turns into money. Two entries point at the cheap model
 * and one at the expensive one, which is worth saying out loud rather than leaving to be
 * read off the object — `medium` is the *ordinary* bead and not a middle case wanting a
 * middle model, so the three-word vocabulary buys a distinction between "easy" and
 * "unremarkable" that costs nothing at spawn time and reads correctly on a card.
 *
 * The values are the `claude` CLI's own aliases rather than model ids, for the same
 * reason `consoleModel` in config.json is one: an alias tracks the current release of a
 * family and a pinned id does not, so a router written with ids would be one that had to
 * be edited every time a model shipped — and until somebody noticed, would quietly keep
 * spawning last year's.
 */
export const MODEL_BY_TIER = { low: 'sonnet', medium: 'sonnet', high: 'opus' };

/**
 * What a bead naming no usable tier runs on — deliberately the **expensive** one.
 *
 * This is the commonest answer in the tracker rather than an edge case: everything filed
 * before bc-nc6o.1 landed, everything created by hand and everything ingested from JIRA
 * is unrated. So the fallback decides most sessions, and it goes the expensive way
 * because the two ways of being wrong are not comparable — routing an easy bead to Opus
 * costs a bill, and routing a hard one to Sonnet costs an unattended hour spent producing
 * something that has to be thrown away and re-run anyway.
 */
export const FALLBACK_MODEL = 'opus';

/** A tier → the model a session on it runs. Anything that is not a tier → the fallback. */
export const modelForTier = (tier) => MODEL_BY_TIER[normalizeTier(tier)] || FALLBACK_MODEL;

/**
 * The model a session on this bead should run: `{ model, tier, problem }`.
 *
 * The one call the dispatcher makes, and it answers with all three because the model on
 * its own cannot be explained. `tier` is what it was routed *by* — `''` for an unrated
 * bead, which is a real answer and not a failure — and `problem` is the sentence
 * `beadComplexity` wrote when the labels said something nobody can route on.
 *
 * **Both not-a-tier answers land on the same model, and that is on purpose.** A bead
 * carrying two tiers and a bead carrying none are different facts about the tracker and
 * the same fact about this run: nothing has told the dispatcher how hard the work is, so
 * it takes the expensive fallback. The difference between them is worth *saying* — which
 * is what `problem` is for, and why the caller logs it — but not worth routing on,
 * because "falls to the cheap model when its labels contradict each other" is the one
 * wrong answer a mislabelled bead could produce in silence.
 *
 * Never throws. A dispatcher that refused to open a window over a malformed label would
 * turn a typo into a bead nothing will ever work.
 */
export function modelForBead(bead) {
  const { tier, problem } = beadComplexity(bead);
  return { model: modelForTier(tier), tier, problem };
}
