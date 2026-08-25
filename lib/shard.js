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
