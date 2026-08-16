/**
 * What a card says about the model a bead runs on — **one derivation, two cards**.
 *
 * bc-nc6o.4 and bc-nc6o.5 are the display half of the routing epic, and they are the
 * same sentence drawn twice: the inbox card in public/app.js says it in a chip, and the
 * bead sheet in public/graph.js says it in a row with room to explain itself. The fact
 * behind both is assembled here, once, and handed to each of them as a field — so the
 * two cards cannot disagree about a bead, which is the failure mode that matters. A chip
 * saying `sonnet` beside a sheet saying `opus` is worse than neither: both are plausible,
 * and there is nothing on either screen to say which one lied.
 *
 * **Derived on the server rather than copied into the browser**, and that is a choice
 * with a precedent on each side. public/graph.js keeps its own `ownersOn`, a client-side
 * copy of `ownersOf`, with test/ownership.mjs pinning the two together; `toQuestion` in
 * lib/decision.js instead derives `addressees` once per sweep and puts the answer on the
 * payload. The rule that decides between them is what is being copied. A **prefix** is a
 * contract a test can pin — duplicate it. A **mapping** is a decision, and
 * `MODEL_BY_TIER` calls itself "the whole of the routing decision, and the only copy of
 * it" for a reason: a second copy of it in a browser is one that goes stale the first
 * time a model ships, and goes stale *silently*, because both copies keep rendering.
 *
 * **Never throws, and answers for every bead.** Most of the tracker names no tier and
 * nothing has ever run on it; that is the ordinary case, not a gap, and it answers with
 * the fallback model rather than a blank. A card that drew nothing for an unrated bead
 * would be saying "this one is not routed", which is false — it is routed to the
 * expensive one, and the whole point of showing it is that somebody can see that and fix
 * the tier.
 */

import { beadComplexity, modelForTier } from './complexity.js';
import { modelsRan, ranDiverged } from './ranmodel.js';

/**
 * Everything either card needs to draw the model, off a `bd --json` row:
 *
 *   - `tier` — `'low' | 'medium' | 'high'`, or `''` for a bead that names none. Never
 *     `null`: `beadComplexity` uses that for "the labels contradict each other", which is
 *     not a tier and must not be drawn as one, so it lands as `''` with a `problem`.
 *   - `model` — what a session on this bead is routed to. Always a model name.
 *   - `fallback` — `true` when that model came from `FALLBACK_MODEL` rather than from a
 *     tier. The chip needs this to word itself honestly: "routed to opus" and "nobody
 *     said, so opus" are the same model and different facts, and only the second one is
 *     something you can act on.
 *   - `problem` — the sentence `beadComplexity` wrote when the labels say something
 *     nobody can route on, or `null`. Shown, because the bead is quietly on the expensive
 *     model until somebody takes the wrong label off.
 *   - `ran` — the families a finished session actually used, off `ran:<family>` labels.
 *     `[]` for the beads nothing has finished on, which is nearly all of them. Two
 *     entries is a session somebody moved mid-run, and both are kept.
 *   - `diverged` — `true` only when both halves are known and they differ. False for an
 *     unworked bead, on purpose: see `ranDiverged`. A card that drew "ran on something
 *     else" from a missing fact would cry wolf on every bead in the tracker.
 */
export function modelCard(bead) {
  const { tier, problem } = beadComplexity(bead);
  const model = modelForTier(tier);
  const ran = modelsRan(bead);
  return {
    tier: tier || '',
    model,
    fallback: !tier,
    problem: problem || null,
    ran,
    diverged: ranDiverged(model, ran),
  };
}
