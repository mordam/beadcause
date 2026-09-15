/**
 * Markdown slicing for `bin/b7e-role` — pure functions over text already read from disk,
 * so `test/role.mjs` can drive every extraction rule against a fixture string and never
 * needs a deluvia checkout on this Mac. The file reads, the workspace lookup and the
 * roster (`rolesOf`/`departmentOf`/`profilePath`, all lib/relay.js) live in the bin.
 *
 * `bc-dgx7.77` names five sessions that each sliced `docs/STUDIO_CHARTER.md` (726 lines)
 * and a role file by hand, differently, every time a role relay opened or changed roles —
 * `wc -l` then a run of `sed -n` guesses, or a `cat` past the tool-result cap recovered
 * with three more `sed` calls. What every one of them actually needed was three things:
 * the role's own block in the charter, the studio's one law, and the role's own profile —
 * never the other four thousand words around them. That is what `sections` below exists
 * to cut cleanly, with the line numbers a disputed slice can be checked against.
 */

/** 1-based line number of the character at `index` in `text`. */
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * `text` with every leading `#` blanked out on lines inside a fenced code block, and
 * nothing else touched — same length, same line breaks, so an index found against the
 * result still points at the right character in the original. `clio.md`'s own output
 * template is a worked example wrapped in a fence, and that example is markdown-shaped
 * report headings (`## Clio's Continuity Report`, `### 1. Timeline`) — without this, the
 * heading scanner below would read the example as more of the document than it is and cut
 * the template off after two lines.
 */
function blankFences(text) {
  const lines = String(text || '').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence && lines[i].startsWith('#')) {
      lines[i] = lines[i].replace(/^#+/, (m) => ' '.repeat(m.length));
    }
  }
  return lines.join('\n');
}

/**
 * Every markdown heading at exactly `level` (`#` repeated that many times), each with its
 * body running up to the next heading at `level` or shallower — or the end of the text.
 * A trailing `---` divider immediately before that boundary is trimmed off the body: it
 * belongs to neither section, and keeping it would put a divider inside every one that
 * ships the same document. Headings are found in a fence-blanked copy of `text` so a
 * worked example inside a code fence is never mistaken for real document structure, but
 * every slice returned is cut from `text` itself, fence markers included.
 */
export function sections(text, level) {
  const src = String(text || '');
  const scan = blankFences(src);
  const own = new RegExp(`^${'#'.repeat(level)}\\s+.*$`, 'gm');
  const stop = new RegExp(`^#{1,${level}}\\s+.*$`, 'gm');
  const marks = [...scan.matchAll(own)];
  const out = [];
  for (const m of marks) {
    stop.lastIndex = m.index + m[0].length;
    const next = stop.exec(scan);
    const end = next ? next.index : src.length;
    let body = src.slice(m.index, end);
    body = body.replace(/\n---\s*\n*$/, '\n');
    out.push({
      heading: m[0].replace(/^#+\s+/, '').trim(),
      startLine: lineOf(src, m.index),
      endLine: lineOf(src, m.index + body.trimEnd().length - 1),
      body: body.trimEnd() + '\n',
    });
  }
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The role's own `####` block from a workspace charter — `#### <role> — <title>` down to
 * the next heading at level 4 or shallower. Case-insensitive and anchored on a word
 * boundary after the name, so `aria` does not also match a prose sentence that happens to
 * start a line with it, and does not match `ariadne` if such a role ever existed.
 */
export function charterBlock(charterText, role) {
  const re = new RegExp(`^${escapeRe(role)}\\b`, 'i');
  return sections(charterText, 4).find((s) => re.test(s.heading)) || null;
}

/** The studio's one law — the level-2 section whose heading names it, wherever it sits. */
export function oneLawSection(charterText) {
  return sections(charterText, 2).find((s) => /\bone law\b/i.test(s.heading)) || null;
}

/**
 * The role file's own declared output section — headings vary across the roster
 * (`Output Format`, `Output Location`, `Outputs`) and several role files declare none at
 * all, folding format into `Production Contract` instead. Null is the honest answer for
 * those; a caller reports it as missing rather than printing nothing under a false label.
 */
export function outputTemplate(roleFileText) {
  return sections(roleFileText, 2).find((s) => /^output/i.test(s.heading)) || null;
}

/**
 * A department heading's gate letters — `gate G2` or `gates G3, G4` — keyed by the
 * `` `dept:key` `` the same heading names, so a caller can pair a role's department with
 * the gate it answers to without a second document format to learn.
 */
export function departmentGates(charterText) {
  const re = /^###\s+.*?`(dept:[a-z0-9_-]+)`.*?\bgates?\s+([A-Za-z0-9,\s]+?)\s*$/gim;
  const out = {};
  let m;
  while ((m = re.exec(String(charterText || ''))) !== null) {
    out[m[1]] = m[2]
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return out;
}

/**
 * The line range of one `export function <name>(` in already-read source, by counting
 * brace depth from its opening `{` back to zero. Used to cite `lib/relay.js` itself as a
 * source for the roster `--next` reads off it — the roster is not a slice of a document,
 * but it is still a specific, checkable range of a specific file.
 */
export function functionRange(source, name) {
  const src = String(source || '');
  const re = new RegExp(`^export function ${escapeRe(name)}\\(`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  let depth = 0;
  let started = false;
  let i = m.index;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') {
      depth += 1;
      started = true;
    } else if (c === '}') {
      depth -= 1;
      if (started && depth === 0) break;
    }
  }
  return { startLine: lineOf(src, m.index), endLine: lineOf(src, i) };
}
