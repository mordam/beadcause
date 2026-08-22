/**
 * The half of the service worker's cache-version ritual that `lib/swbump.js` does not
 * answer: which number a bump takes, the note that argues for it, and how to resolve the
 * add/add conflict a downmerge routinely produces. `bin/b7e-swbump` is the argv shell
 * around this; everything here reads no git of its own, on purpose, so it is testable
 * from strings the way `lib/swbump.js` already is.
 *
 * Three sessions did this by hand and none of them the same way (bc-khoe.23, bc-khoe.26,
 * bc-ka5y.15.3 — see bc-khoe.44, which this file answers). The one that mattered:
 * bc-ka5y.15.3 took v78 the first time because a *sibling worktree on the same Mac* held
 * an unmerged v77, and `test/swcache.mjs` requires the notes to be contiguous, so a v78
 * beside a v76 failed the suite. The number is a property of `origin/main` — or whatever
 * ref the caller is comparing against — never of what another worktree happens to hold
 * locally, and nothing before this computed it that way on purpose. `nextNumber` below
 * is handed the numbers read out of *that ref*, never out of the working directory, and
 * that is the whole fix: a sibling's unmerged note simply never appears in the list this
 * reads from.
 *
 * The other half is the conflict itself. `docs/sw-cache/README.md` already writes the
 * resolution down — keep both notes, move the later one up, set `const CACHE` by hand to
 * the new highest — and `conflictedNotes` + the renumber helpers below are that
 * procedure typed once instead of re-derived per downmerge.
 */

/** The numbers already claimed, out of a flat list of names (a directory listing or a `git ls-tree`). Unsorted input is fine. */
export function noteNumbers(entries) {
  return entries
    .filter((f) => /^v\d+\.md$/.test(f))
    .map((f) => Number(f.slice(1, -3)))
    .sort((a, b) => a - b);
}

/** One past the highest number that exists. `numbers` is never empty in a real repo — `test/swcache.mjs` itself refuses fewer than two notes — but v1 is the honest answer if it ever is. */
export function nextNumber(numbers) {
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

/**
 * `const CACHE = 'beadcause-vNN';` rewritten to a new number.
 *
 * Throws rather than silently doing nothing if the line is not there exactly once — the
 * same guard `test/swcache.mjs`'s own `declared()` uses, because a second copy or none at
 * all means something has already gone wrong that a written-over `sw.js` would hide.
 */
export function setConst(source, number) {
  const re = /^const CACHE = 'beadcause-v\d+';$/m;
  const all = [...source.matchAll(/^const CACHE = 'beadcause-v\d+';$/gm)];
  if (all.length !== 1) throw new Error(`public/sw.js declares the cache version ${all.length} times, not once`);
  return source.replace(re, `const CACHE = 'beadcause-v${number}';`);
}

/**
 * The first line of a note, renumbered — the half of a `git mv` renumber that the rename
 * itself never does, and the thing `test/swcache.mjs`'s "each note says its own number"
 * check exists to catch when it is forgotten.
 */
export function renumberHeading(content, number) {
  const lines = content.split('\n');
  const m = lines[0].match(/^# v(\d+) — (.*)$/);
  if (!m) throw new Error(`first line is not "# vNN — what changed": ${lines[0]}`);
  lines[0] = `# v${number} — ${m[2]}`;
  return lines.join('\n');
}

/**
 * The `## The number` section a renumbered note carries — the convention visible in
 * `docs/sw-cache/v81.md` and `v98.md`: what it was written against, what it was claimed
 * as, and what it actually landed as. Appended, never replacing anything already there,
 * because the note's own argument about which files pair up does not depend on which
 * number it carries.
 */
export function numberSection({ against, claimedAs, landedAs }) {
  const prefix = against != null ? `Written against v${against} and claimed as v${claimedAs}` : `Claimed as v${claimedAs}`;
  const line = `${prefix}, landing as v${landedAs} — the collision docs/sw-cache/README.md asks for: the note ` +
    'already reachable through the tracked history this branch merged with kept its number, and this one ' +
    'moved up rather than dropping the number it left behind.';
  return ['', '## The number', '', line, ''].join('\n');
}

/**
 * `docs/sw-cache/vNN.md` entries in `git status --porcelain` that are an unresolved
 * add/add — both sides claimed the same number and git left it as a conflict rather than
 * a silent merge, which is the whole reason the number lives in a filename and not only
 * in the `const`.
 */
export function conflictedNotes(porcelain) {
  const found = [];
  for (const line of String(porcelain || '').split('\n')) {
    if (!line.startsWith('AA ')) continue;
    const p = line.slice(3).trim();
    const m = p.match(/^docs\/sw-cache\/v(\d+)\.md$/);
    if (m) found.push({ path: p, number: Number(m[1]) });
  }
  return found;
}

/**
 * The note body a bump scaffolds: the heading, the argument `lib/swbump.js` already
 * worked out (its `report()` lines — the whole reason a scaffolded note is not a stub:
 * the pairing that made the bump owed is already known, in prose, before this is called),
 * and which files moved together.
 */
export function scaffoldNote({ number, summary, argument, files }) {
  const lines = [`# v${number} — ${summary}`, ''];
  lines.push(...(argument && argument.length ? argument : ['Bumped by hand; see the pull request this note ships with for what changed.']));
  lines.push('');
  lines.push('## What changed');
  lines.push('');
  for (const f of files) lines.push(`- ${f}`);
  lines.push('');
  return lines.join('\n');
}

/** A short heading phrase out of `lib/swbump.js`'s own verdict — the first thing its `report()` would tell a human, trimmed to a title. */
export function summarize(result) {
  const throwing = (result.scripts || []).filter((s) => !s.guarded);
  if (result.couplings?.length) {
    const c = result.couplings[0];
    return `${c.calls} calls .${c.member}(), which ${c.defines} only gained on this branch`;
  }
  if (throwing.length) {
    const s = throwing[0];
    return `${s.calls} calls window.${s.chain}(), which ${s.tags.join(', ')} only just started loading`;
  }
  if (result.styles?.length) {
    const c = result.styles[0];
    return `${c.draws} newly draws ${c.selector}, which ${c.styles} only gained on this branch`;
  }
  return `a sw-cache bump for ${result.changed?.length || 0} changed shell file(s)`;
}
