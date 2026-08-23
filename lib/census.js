/**
 * Which rows in a real tracker match a label or dependency predicate — the one question
 * three sessions each answered by hand, three different ways.
 *
 * `bc-bmry.2` piped `bd list --all --limit 0 --json` into an inline `node -e` that
 * accumulated stdin, `JSON.parse`d it and filtered for the exact `gate` label.
 * `bc-bmry.5` wrote a whole `scratchpad/real.mjs` to run a similar filter over a file it
 * had saved `bd list --json` to first. `bc-xl7n.98` used `bd export` and three separate
 * `python3 - <<'EOF'` programs — one of them joining labels to dependency edges to find
 * `in_progress` beads blocked by an open `pr-delivery` card. Same question, three
 * transports, three languages. This is the matching, pulled out so `bin/b7e-census` is
 * only the argv parsing and the printing around it — the same split `lib/affected.js` /
 * `bin/b7e-affected` already made for a different question.
 *
 * Deliberately takes `{ beads, edges }` — the shape `indexFrom` in `lib/ancestry.js`
 * already parses a `bd export` into — rather than a workspace to spawn `bd` against, for
 * the reason that file gives for the same split: the caller that has a `bd` to run is not
 * the caller that knows what a predicate over the result means, and a pure function here
 * is one a test can drive with a handful of plain objects instead of a stub binary.
 *
 * **Labels match exactly, never by prefix.** `lib/approval.js` already argues this for the
 * one label family it knows about — the bare label `gate` means "I am a gate" and
 * `gate:G0` is an ordinary deliverable under it, so `startsWith('gate')` would silently
 * pull in the work a gate is *for* — and nothing here has a narrower reason to draw the
 * line differently for any other label. A caller that wants the whole family asks
 * `valuesOf` instead, which is where that widening actually belongs.
 *
 * **No status filter is applied unless one is asked for**, which is what makes `--label
 * gate --count` reproduce `bc-bmry.2`'s `bd list --all` pipeline rather than `bd list`'s
 * own closed-hiding default: an index built from `bd export` already carries closed rows,
 * and silently dropping them here would make this answer a different question than the
 * one it was filed to replace.
 */

/** Split "gate:" or "gate" into the bare family name both forms share. */
function familyPrefix(prefix) {
  return String(prefix || '').replace(/:$/, '');
}

/** Does `label` belong to the family named by `prefix` — itself, or `<prefix>:anything`? */
export function inFamily(label, prefix) {
  const p = familyPrefix(prefix);
  if (!p) return false;
  const l = String(label || '');
  return l === p || l.startsWith(`${p}:`);
}

/**
 * The ids `bead` is blocked by, still live, that carry `label` exactly.
 *
 * A `blocks` edge is read the way `Bd.gateFor` already reads one off `bd show` — `from` is
 * the blocked bead, `to` is the blocker (see `lib/ancestry.js`'s `indexFrom`, which keeps
 * `dep.issue_id` as `from` and `dep.depends_on_id` as `to`) — and a blocker counts only
 * while it is still open: a closed blocker is finished work, not a live gate on anything.
 */
function liveBlockersWithLabel(beadId, edges, beads, label) {
  const out = [];
  for (const edge of edges.values()) {
    if (edge.type !== 'blocks' || edge.from !== beadId) continue;
    const blocker = beads.get(edge.to);
    if (!blocker || blocker.status === 'closed') continue;
    if (!(blocker.labels || []).includes(label)) continue;
    out.push(blocker.id);
  }
  return out;
}

/**
 * Every bead in `index` matching `predicate`, sorted by id for a deterministic answer.
 *
 * `predicate`:
 * - `labels` — every one of these must be on the bead, exact match, ANDed (bc-bmry.2's
 *   shape: filtering for more than one label narrows, it never widens).
 * - `notLabels` — none of these may be on the bead.
 * - `statuses` — an array/Set of `bd` statuses the bead's own status must be one of.
 *   Omitted (or empty) matches every status, closed included — see the header.
 * - `blockedByLabel` — the bead must be blocked by at least one still-open bead carrying
 *   this label exactly (`bc-xl7n.98`'s join).
 */
export function census(index, predicate = {}) {
  const beads = index?.beads || new Map();
  const edges = index?.edges || new Map();
  const labels = predicate.labels || [];
  const notLabels = predicate.notLabels || [];
  const statuses = predicate.statuses && predicate.statuses.length ? new Set(predicate.statuses) : null;
  const blockedByLabel = predicate.blockedByLabel || null;

  const rows = [];
  for (const bead of beads.values()) {
    const beadLabels = bead.labels || [];
    if (labels.some((l) => !beadLabels.includes(l))) continue;
    if (notLabels.some((l) => beadLabels.includes(l))) continue;
    if (statuses && !statuses.has(bead.status)) continue;
    if (blockedByLabel && liveBlockersWithLabel(bead.id, edges, beads, blockedByLabel).length === 0) continue;
    rows.push(bead);
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/**
 * The distinct label values in a family — `gate` and every `gate:GN` — with how many live
 * (by default) beads carry each, for the one question `bd`'s own `list --label` cannot
 * answer at all: "what are the values", not "which beads have this one".
 *
 * `statuses` narrows the same way `census`'s does; omitted, every status counts.
 */
export function valuesOf(index, prefix, { statuses = null } = {}) {
  const beads = index?.beads || new Map();
  const wanted = statuses && statuses.length ? new Set(statuses) : null;
  const counts = new Map();
  for (const bead of beads.values()) {
    if (wanted && !wanted.has(bead.status)) continue;
    for (const label of bead.labels || []) {
      if (!inFamily(label, prefix)) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return counts;
}
