/**
 * Which beads a pull request is *for* — the one implementation of that question.
 *
 * This was private to lib/prboard.js, where it answers "what is this row about?" for a
 * screen. lib/landed.js then needed the identical question for a very different
 * purpose: a pull request merged on github.com closes nothing here, so something has
 * to walk the merged ones and close the beads behind them. Two implementations of
 * "which bead is this PR for" is the worst possible way to hold that, because the
 * screen would say one thing and the sweep would close another — so it lives here,
 * with the same reasoning it always had, and both import it.
 *
 * The reasoning that matters is the tiering. A delivery whose body ended "nothing was
 * done about bc-2tr / bc-es8 / bc-dmt, which this unblocks" came back linked to four
 * beads, three of which it explicitly had not touched. All four exist, so verifying
 * against the tracker cannot separate them — only *where they were written* can. That
 * mattered on a board; it matters far more now that the answer decides what gets
 * closed.
 */

/** `bc` for the beadcause workspace. Prefixes never change, so this is asked once. */
const prefixes = new Map();

export async function prefixFor(bd, ws) {
  if (prefixes.has(ws.name)) return prefixes.get(ws.name);
  let prefix = null;
  try {
    const rows = await bd.json(ws, ['list', '--limit', '1']);
    const found = String(rows?.[0]?.id || '').split('-')[0];
    // Checked rather than trusted: this string is interpolated into three regexes
    // below, and a prefix is a short word by construction. A tracker that ever
    // returned something else should produce no matches, not a pattern.
    prefix = /^[a-z0-9]{1,10}$/i.test(found) ? found : null;
  } catch {
    // A workspace whose database is mid-write has no prefix this tick. Not cached —
    // an unreadable tracker is a passing state and the next sweep should ask again.
    return null;
  }
  if (prefix) prefixes.set(ws.name, prefix);
  return prefix;
}

/** For tests, and for anything that knows a workspace's tracker was replaced. */
export const forgetPrefixes = () => prefixes.clear();

/**
 * Ids this pull request might be *for*, in tiers — and only one tier is ever used.
 *
 * A bead named in the `beadpr` block, in the title, or by the branch's own tag is a
 * bead this PR is **for**. Anything else in the body is a bead it *mentions*, and
 * mentions are used only when nothing stronger is there — which is the hand-opened PR
 * whose body says "fixes bc-x" and nothing else does.
 */
export function candidateTiers(row, prefix) {
  if (!prefix) return [];
  /**
   * A bead id, **including its dotted child suffix** — bc-68ou.10.
   *
   * Without `(?:\.\d+)*` this stopped at the first dot, so every child id written in a
   * title came back as its **parent**: `bc-68ou.6: …` resolved to `bc-68ou`, a P0 epic.
   * The `bead:` block below never had the bug — it captures `\S+` and keeps the dots — so
   * a delivery's own pull request produced *both* forms in one tier (`['bc-68ou.6',
   * 'bc-68ou']`), the right bead and the epic above it, and everything downstream took
   * them as equally strong claims.
   *
   * That was invisible for as long as nothing acted on the second one. lib/landed.js
   * escaped it only by a guard further down — `closeGate` refuses to close an epic on a
   * merge reason — and lib/release.js's `homeOf` escaped it because the parent of a child
   * and the parent of its epic are usually the same P0. What made it visible was labelling:
   * `shipped` has no such guard, so the first real sweep marked seven P0 epics as shipped
   * because one child of each had merged.
   *
   * `\d+` and not `[a-z0-9]+`, because a suffix is a number — `bc-rfnr.9.3` is real and
   * nests, so the group repeats.
   */
  const re = new RegExp(`\\b${prefix}-[a-z0-9]{2,10}(?:\\.\\d+)*\\b`, 'gi');
  const idsIn = (text) => [...String(text || '').matchAll(re)].map((m) => m[0].toLowerCase());

  const body = String(row.body || '');
  const named = new Set();

  // `bead: bc-jin` inside the block lib/delivery.js writes — the one place in this
  // whole codebase where a PR states outright which bead it delivers.
  const declared = body.match(/^[ \t]*bead:[ \t]*(\S+)[ \t]*$/m)?.[1];
  if (declared && new RegExp(`^${prefix}-`, 'i').test(declared)) named.add(declared.toLowerCase());
  for (const id of idsIn(row.title)) named.add(id);
  for (const id of idsIn(row.branch)) named.add(id);

  // The worktree convention: `worktree-launcher-repo-tabs-jin` ends in the bead's own
  // suffix, because that is where the tag comes from. Its own tier, below the ids that
  // were actually written out: on a branch called `some-branch` this guesses
  // `<prefix>-branch`, and a guess that fails must fall through to the body rather
  // than counting as an answer and stopping the search.
  const tail = String(row.branch || '').split('-').pop();
  const guess = tail && /^[a-z0-9]{2,10}$/i.test(tail) ? [`${prefix}-${tail}`.toLowerCase()] : [];

  // Last: the body — but only where it *claims* a bead rather than mentioning one.
  // "Fixes bc-x" is a claim; "nothing was done about bc-x, which this unblocks" is
  // not, and an open pull request on this board carried three of the second kind. So
  // this tier reads the verb, not just the id: no verb, no link, and the row says
  // "no bead named", which is the truth about a pull request nobody tied to one.
  const claim = new RegExp(
    `\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|deliver(?:s|ed|ing)?|implement(?:s|ed)?|for|bead)\\b[:\\s]+` +
      // Same dotted suffix as `re` above, and for the same reason: "fixes bc-68ou.6" is a
      // claim on the child, and reading it as a claim on the epic is the one mistake this
      // whole file exists to avoid.
      `(?:issue\\s+)?(${prefix}-[a-z0-9]{2,10}(?:\\.\\d+)*)\\b`,
    'gi'
  );
  const claimed = [...new Set([...body.slice(0, 8000).matchAll(claim)].map((m) => m[1].toLowerCase()))].slice(0, 2);

  return [[...named].slice(0, 4), guess, claimed].filter((t) => t.length);
}

/**
 * Which beads a pull request is for — verified against the tracker, never guessed.
 *
 * `seen` is the caller's own memo. Half a dozen PRs mentioning the same bead is normal
 * (a delivery, its follow-up, the bead that discovered both), and asking `bd` again
 * for each is the difference between a board that loads and one you wait for.
 */
export async function beadsFor(bd, ws, prefix, row, seen) {
  for (const tier of candidateTiers(row, prefix)) {
    const found = await resolve(bd, ws, tier, seen);
    // The first tier that resolves to anything wins outright. A weaker tier is only
    // ever consulted because the stronger one turned out to name nothing real.
    if (found.length) return found;
  }
  return [];
}

/** Ask the tracker about one tier's ids, memoised across the whole sweep. */
async function resolve(bd, ws, ids, seen) {
  const out = [];
  for (const id of ids) {
    const key = `${ws.name}/${id}`;
    // The *promise* is memoised, not the answer. Every repo's pull requests are
    // resolved concurrently, so two rows naming the same bead reach this within a
    // tick of each other — caching the settled value would let both miss and both
    // ask, which is the case the memo exists for.
    if (!seen.has(key)) {
      seen.set(
        key,
        bd
          .show(ws, id)
          .then((b) => (b ? { id: b.id, title: b.title || '', status: b.status || '' } : null))
          .catch(() => null)
      );
    }
    const bead = await seen.get(key);
    if (bead) out.push(bead);
  }
  return out;
}
