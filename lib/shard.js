/**
 * Slicing the suite list N ways for CI (bc-xlz32.4).
 *
 * `scripts/test.mjs --list` is the one place the suite order is decided — pinned
 * `test/lockfile.mjs` and `scripts/selftest.mjs` first, `scripts/test-swap.js` last, the
 * rest alphabetical — and `lib/gate.js`'s `discoverSuites()` already reuses it by shelling
 * out rather than reimplementing it. This file adds nothing to that discovery; it only
 * slices the list `discoverSuites()` returns, so a CI shard and a local `--only` run can
 * never disagree about what a suite *is*.
 *
 * ## Stride, not a contiguous block
 *
 * `suites[i]` goes to shard `i % total`, not to `shard floor(i / (len/total))`. The list is
 * not uniform cost: the pinned suites at the front and back, the nine `*real.mjs` suites,
 * and `test/landcheck.mjs` all run far longer than the alphabetical middle, and a
 * contiguous block would put however many of those happen to sort together into whichever
 * one shard's slice covers that stretch — the whole point of sharding is defeated by one
 * slow shard holding up the rest. Stride spreads them out without needing to know in
 * advance which suites are the expensive ones.
 *
 * ## The invariant this exists to hold
 *
 * `total` shards, run and unioned, must reproduce the input list exactly — no suite
 * skipped (a hole in coverage nobody would notice, because CI would still go green) and no
 * suite duplicated (wasted runner time, and if two shards raced a stateful suite, a flake
 * with no local repro). `test/shard.mjs` asserts this for every shard count `.github/
 * workflows/test.yml` actually uses, plus a spread that was never tuned for, and for a
 * shard count of 1 — the shard equals the whole list, which is the shape this collapses to
 * if CI is ever run unsharded again.
 */

/**
 * `known` narrowed to the suites in `wanted` — the composition CI uses on a pull request
 * (bc-xlz32.8), where `wanted` is `b7e-affected`'s answer for the diff.
 *
 * Two things it settles, both of which are wrong the other way round:
 *
 * **The order comes from `known`, never from `wanted`.** `discoverSuites()` is the one
 * place suite order is decided — pinned first, pinned last, alphabetical between — and
 * the stride above spreads cost on the assumption that it is looking at that order. An
 * affected list arrives sorted alphabetically, which would quietly undo it.
 *
 * **A suite `known` has never heard of is dropped, not an error.** `b7e-affected`'s
 * universe is deliberately wider than the gate's: it matches browser checks under
 * `scripts/*-check.mjs` too, and `b7e-gate --only` refuses a name it cannot resolve
 * (`lib/shipgate.js`'s header has the whole argument). So a diff whose only cover is a
 * browser check narrows to an empty list here, which is a shard with nothing to run —
 * not a manufactured failure.
 *
 * An **empty `wanted` means everything**, the same contract `--only` and `b7e-affected`'s
 * empty stdout already carry: nothing matched is the signal to fall back, never the
 * signal to run nothing.
 */
export function narrowTo(known, wanted) {
  if (!wanted || !wanted.length) return [...known];
  const want = new Set(wanted);
  return known.filter((s) => want.has(s));
}

/** One shard of `suites` — the `index`-th of `total`, 0-based. */
export function shardOf(suites, index, total) {
  if (!Number.isInteger(total) || total < 1) {
    throw new RangeError(`shardOf: total must be a positive integer, got ${total}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new RangeError(`shardOf: index must be an integer in [0, ${total}), got ${index}`);
  }
  return suites.filter((_, i) => i % total === index);
}
