/**
 * Did this branch ship a pair of shell files that a phone can hold half of?
 *
 * `public/sw.js` precaches every path in `SHELL` under one key, `const CACHE =
 * 'beadcause-vNN'`, and whether a branch owes a bump of that number is decided by a
 * human reading the diff. Several suites assert that a particular path is *listed* in
 * SHELL; nothing asked the other question — whether a change that touched two of those
 * files moved the version they arrive under.
 *
 * The case that made this worth writing is bc-dmt (#115). `public/console.js` gained
 * two calls to `chat.queue.repaint()`; `public/sendqueue.js` gained the `repaint` key
 * they call, on the same branch. Both files are in SHELL, `const CACHE` was
 * byte-identical to main, every one of the 120-odd suites was green and the pull
 * request was clean and mergeable. A phone holding the old `sendqueue.js` beside the
 * new `console.js` gets a `TypeError` on the one gesture the branch adds. The only
 * thing that caught it was somebody reading the diff by eye — and then two further
 * sessions re-deriving the same finding from scratch (bc-w122, bc-8cuq).
 *
 * So there are two signals here, and they are deliberately not the same strength:
 *
 * - **The advisory.** Two or more SHELL files changed and the version did not move.
 *   That over-reports on purpose — the purely additive change legitimately skips the
 *   bump (bc-p38c.2 put `report.js` on all twelve pages and owed nothing, because old
 *   cached HTML without the tag is the app exactly as it was). It names the files and
 *   says nothing else; the judgement stays with the person reading it.
 *
 * - **The failure.** One modified SHELL file gained a member, another modified SHELL
 *   file gained a *call* to it, and the version did not move. That is not a judgement
 *   call: on the mixed pair the call lands on `undefined` and throws. Both files have
 *   to have existed before the branch — two files added *together* are never a mixed
 *   pair, since a cache from before the branch has neither, which is what keeps the
 *   additive case out of the failing half.
 *
 * - **The named pair inside the advisory.** One modified shell file newly *draws* a
 *   class or id and another newly *styles* it — bc-jdwc, and the shape `public/sw.js`'s
 *   own version notes argue about most. It stays inside the advisory rather than
 *   becoming a second red, and that is measured rather than asserted: replayed over the
 *   last 75 pull requests to merge it fires on exactly one unbumped branch (bc-pzti's
 *   `.bead-dupe`, genuinely owed), and independently finds the coupling in 12 of the 13
 *   branches that *did* bump. So it agrees with almost every bump a human made and adds
 *   no alarm of its own — every fire is a case the advisory already printed. What keeps
 *   it out of the failing half is that its damage is a judgement in a way a `TypeError`
 *   is not: `.bead-dupe` unstyled is a warning in the wrong colour, and v37's nav
 *   unstyled is a run of naked links. This names the pair; the reader still judges it.
 *
 * The trap this had to be built around: `repaint` appears five times in the *base*
 * `sendqueue.js`, every one of them prose in a comment, which is exactly what nearly
 * fooled two of the sessions that read it by hand. Comments are stripped before
 * anything is read out of a line, and a member counts as "gained" only if it is
 * *defined* at head and not defined at base — appearing in the file is not enough.
 *
 * Nothing here reads git. The caller hands in the two versions of each changed file
 * and the lines the diff added, so the whole of it is testable from fixtures, and the
 * one suite that does read git (`test/swbump.mjs`) can point it at any two revisions.
 */

/** Every path listed in `SHELL`, in order, as written. */
export function shellPaths(swSource) {
  const open = swSource.indexOf('const SHELL = [');
  if (open === -1) return [];
  const close = swSource.indexOf('\n];', open);
  const body = swSource.slice(open, close === -1 ? undefined : close);
  return [...body.matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
}

/**
 * The files on disk that SHELL covers, as repo-relative paths.
 *
 * A SHELL entry is a URL, not a filename, and the two part company in both directions.
 * Extensionless entries (`/`, `/session`, `/prs`) are aliases `serveStatic` resolves to
 * a page listed beside them, so they map to nothing of their own; and an entry that
 * *looks* like a file can be an alias too — `/work.html` has had no file behind it
 * since the sessions view was merged into the console (lib/server.js:1905), and is in
 * SHELL because it is still on somebody's home screen. So this maps optimistically and
 * the paths that match nothing on disk simply never match a changed file either. See
 * test/pagepaths.mjs for what answers to what.
 */
export function shellFiles(swSource) {
  const files = new Set();
  for (const p of shellPaths(swSource)) {
    if (!/\.[a-z0-9]+$/i.test(p)) continue;
    files.add(`public${p}`);
  }
  return files;
}

/** The cache key as declared, or null if the line is not where it has always been. */
export function cacheVersion(swSource) {
  const m = /^const CACHE = '([^']+)';$/m.exec(swSource);
  return m ? m[1] : null;
}

/**
 * A line with its comments taken off.
 *
 * Crude on purpose — a line inside a block comment is recognised by the `*` it opens
 * with, which is how every comment in this repo is written, and `//` is cut wherever it
 * appears. It does not need to be a parser: it needs to not read prose as code, and the
 * five `repaint`s in the base `sendqueue.js` are all prose.
 */
export function stripComments(line) {
  const t = line.trim();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return '';
  return line.replace(/\/\/.*$/, '');
}

/** Reserved words a `name:` or `name(` shape can produce that are never members. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'case', 'default', 'else', 'do', 'try', 'catch',
  'finally', 'return', 'function', 'class', 'const', 'let', 'var', 'new', 'typeof',
  'instanceof', 'await', 'async', 'yield', 'throw', 'delete', 'void', 'in', 'of',
  'this', 'true', 'false', 'null', 'undefined', 'import', 'export', 'extends', 'super',
]);

/**
 * Members so ordinary that two files gaining and calling one says nothing about
 * whether they are a pair. Everything here is a built-in or DOM member: a file that
 * "defines" `then` or `remove` is almost always writing a promise or an element, not an
 * interface its sibling now depends on.
 */
const UBIQUITOUS = new Set([
  'then', 'catch', 'finally', 'map', 'filter', 'forEach', 'find', 'reduce', 'sort',
  'slice', 'splice', 'push', 'pop', 'shift', 'join', 'split', 'trim', 'replace',
  'includes', 'indexOf', 'toString', 'valueOf', 'call', 'apply', 'bind', 'add',
  'remove', 'has', 'get', 'set', 'delete', 'clear', 'keys', 'values', 'entries',
  'length', 'json', 'text', 'querySelector', 'querySelectorAll', 'appendChild',
  'addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'focus',
  'blur', 'click', 'preventDefault', 'stopPropagation', 'scrollIntoView', 'log',
]);

const named = (n) => n.length >= 3 && !KEYWORDS.has(n) && !UBIQUITOUS.has(n);

/**
 * Every member this source defines: object-literal keys, method shorthand, and
 * assignments onto the handful of receivers that mean "this is my surface" — `this`,
 * `window`, `globalThis`, `self`.
 *
 * Over-broad by design. It is only ever used as a *difference* between two revisions of
 * one file, and then only against what another file newly calls, so a stray `case foo:`
 * costs nothing unless a sibling happens to gain a call to `.foo()` in the same diff.
 */
export function memberDefs(source) {
  const defs = new Set();
  for (const raw of String(source).split('\n')) {
    const line = stripComments(raw);
    if (!line.trim()) continue;
    const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (key && named(key[1])) defs.add(key[1]);
    const method = /^\s*(?:static\s+)?(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/.exec(line);
    if (method && named(method[1])) defs.add(method[1]);
    for (const m of line.matchAll(/\b(?:this|window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) {
      if (named(m[1])) defs.add(m[1]);
    }
  }
  return defs;
}

/**
 * Every member these lines *call* — `.name(` and `?.name(`, and nothing else.
 *
 * Reads (`.name` with no call) are left out deliberately. A read of a member the other
 * half of the pair does not have is `undefined`, which may well be harmless; a call is
 * a `TypeError` every time, and this half of the check is the half that fails a branch.
 */
export function memberCalls(lines) {
  const calls = new Set();
  for (const raw of lines) {
    const line = stripComments(raw);
    for (const m of line.matchAll(/\??\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (named(m[1])) calls.add(m[1]);
    }
  }
  return calls;
}

/**
 * Every class and id a stylesheet *styles*, as `.name` / `#name`.
 *
 * Only selector text is read — the run before each `{`, with block bodies and comments
 * thrown away. That is not fastidiousness: `background: #141a22` is a declaration, and
 * a reader that swept the whole file would report `#141a22` as a styled id on every
 * branch that touched a colour. Nesting is handled by the same scan, so the preludes
 * inside an `@media` block count exactly as the ones outside it do.
 */
export function styleSelectors(cssSource) {
  const src = String(cssSource).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const selectors = new Set();
  let prelude = '';
  const take = () => {
    for (const m of prelude.matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) selectors.add(m[1] + m[2]);
  };
  for (const ch of src) {
    if (ch === '{') {
      take();
      prelude = '';
    } else if (ch === '}') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return selectors;
}

/**
 * The same comment-stripping, minus the one rule that costs markup a whole line.
 *
 * `stripComments` cuts at `//` wherever it appears, which is right for a script and
 * wrong for a page: `<a class="dupe" href="https://x">` would lose everything after the
 * scheme, and with it the attribute that mattered. An HTML comment opener earns the
 * whole line, the same way a block-comment `*` does.
 */
function stripMarkupComments(raw) {
  const t = raw.trim();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('<!--')) return '';
  return raw.replace(/(^|[^:])\/\/.*$/, '$1');
}

/** A `class="a b"` value with any interpolation in it dropped, token by token. */
function classTokens(value, into) {
  for (const token of value.split(/\s+/)) {
    if (!token || /[${}`]/.test(token)) continue;
    if (/^-?[A-Za-z_][\w-]*$/.test(token)) into.add(`.${token}`);
  }
}

/**
 * Every class and id these lines *put on the page* — the markup half of the pair.
 *
 * Four shapes, which is all this app writes: a `class=` or `id=` attribute in an HTML
 * file or a template literal, an assignment to `.className`, and `classList.add` /
 * `classList.toggle`. Interpolated tokens (`class="chip ${tone}"`) are dropped rather
 * than guessed at — the literal half of that attribute is still read, and a name only a
 * variable knows is not a name a stylesheet diff can be matched against.
 *
 * `classList.remove` and `.contains` are deliberately out: they are about a class the
 * page already has, and the question here is what this branch newly draws.
 */
export function markupSelectorUses(lines) {
  const uses = new Set();
  for (const raw of lines) {
    const line = stripMarkupComments(raw);
    for (const m of line.matchAll(/\bclass\s*=\s*(["'])([^"'<>]*)\1/g)) classTokens(m[2], uses);
    for (const m of line.matchAll(/\bclassName\s*=\s*(["'`])([^"'`]*)\1/g)) classTokens(m[2], uses);
    for (const m of line.matchAll(/classList\s*\.\s*(?:add|toggle)\s*\(([^)]*)\)/g)) {
      for (const arg of m[1].matchAll(/(["'])([^"']*)\1/g)) classTokens(arg[2], uses);
    }
    for (const m of line.matchAll(/\bid\s*=\s*(["'])([^"'<>\s${}`]*)\1/g)) {
      if (/^-?[A-Za-z_][\w-]*$/.test(m[2])) uses.add(`#${m[2]}`);
    }
  }
  return uses;
}

/**
 * The stylesheet half of a mixed pair: a name this branch newly *draws* in one cached
 * file and newly *styles* in another.
 *
 * This is the shape `public/sw.js`'s own version notes argue about most and the member
 * check could never see. v37's is the canonical one — `console.html` against v36's
 * `style.css` draws the nav as a run of unstyled links, "which still works, which is
 * exactly the 'looks like a working page' failure a cache version exists to prevent".
 * Nothing is missing and nothing throws; the page is simply laid out by a stylesheet
 * that has never heard of it.
 *
 * Both halves have to have *gained* the name, which is what keeps the ordinary churn
 * out. A stylesheet that restyles `.chip` says nothing — the page drew `.chip` before
 * and the cached older half draws it the way it always did, which is merely older. A
 * page that gains a `class="chip"` says nothing either, for the same reason from the
 * other side. It is only when neither half of the cache has heard of the name that the
 * phone holding one of them lays out nothing for it.
 */
export function styleCouplings(modified) {
  const found = [];
  const sheets = modified.filter((f) => f.path.endsWith('.css'));
  const markup = modified.filter((f) => /\.(html|js)$/.test(f.path));
  for (const sheet of sheets) {
    const gained = styleSelectors(sheet.head);
    for (const old of styleSelectors(sheet.base)) gained.delete(old);
    if (!gained.size) continue;
    for (const page of markup) {
      const before = markupSelectorUses(String(page.base).split('\n'));
      for (const selector of markupSelectorUses(page.added)) {
        if (gained.has(selector) && !before.has(selector)) {
          found.push({ selector, styles: sheet.path, draws: page.path });
        }
      }
    }
  }
  return found;
}

/**
 * @param {object} input
 * @param {string} input.swBase   public/sw.js as the branch found it
 * @param {string} input.swHead   public/sw.js as the branch leaves it
 * @param {Array}  input.files    one entry per changed file: { path, status: 'A'|'M'|'D',
 *                                base, head, added: string[] }
 */
export function analyse({ swBase, swHead, files }) {
  const shell = shellFiles(swHead || swBase || '');
  const before = cacheVersion(swBase || '');
  const after = cacheVersion(swHead || '');
  // The version, not the file. A branch can edit sw.js — a path added to SHELL, a note
  // rewritten — and still leave every installed phone on the key it already has.
  const bumped = Boolean(after) && after !== before;

  const changed = files.filter((f) => shell.has(f.path) && f.status !== 'D');
  const modified = changed.filter((f) => f.status === 'M');

  const couplings = [];
  for (const from of modified) {
    const gained = memberDefs(from.head);
    for (const old of memberDefs(from.base)) gained.delete(old);
    if (!gained.size) continue;
    for (const to of modified) {
      if (to.path === from.path) continue;
      // A call `to` could be making on itself is not evidence about `from`.
      const own = memberDefs(to.head);
      for (const name of memberCalls(to.added)) {
        if (gained.has(name) && !own.has(name)) couplings.push({ member: name, defines: from.path, calls: to.path });
      }
    }
  }

  return {
    bumped,
    version: { before, after },
    changed: changed.map((f) => f.path),
    // Two files is the point: one changed shell file has no other half to disagree with.
    advisory: !bumped && changed.length >= 2,
    couplings: bumped ? [] : couplings,
    styles: bumped ? [] : styleCouplings(modified),
  };
}

/** What the suite prints. Lines, so the caller decides what to do with them. */
export function report(result) {
  const lines = [];
  if (result.couplings.length) {
    lines.push(`public/sw.js still says ${result.version.after} and this branch ships a pair that needs it moved:`);
    for (const c of result.couplings) {
      lines.push(`  ${c.calls} calls .${c.member}(), which ${c.defines} only gained on this branch`);
    }
    lines.push('A phone holding the cached older half throws on that call. Bump const CACHE in public/sw.js.');
    return lines;
  }
  if (result.advisory) {
    lines.push(`${result.changed.length} files in SHELL changed and const CACHE is still ${result.version.after}:`);
    for (const p of result.changed) lines.push(`  ${p}`);
    if (result.styles?.length) {
      // The advisory's own claim, made specific. "Five files moved" is a shrug; naming
      // the class one of them newly draws and another newly styles is the pair itself,
      // and leaves the reader only the question they are actually better at than this
      // file is — whether that particular name unstyled is a broken screen or a slightly
      // wrong colour.
      lines.push(`and ${result.styles.length === 1 ? 'one name' : `${result.styles.length} names`} in that set is drawn by one half and styled by the other:`);
      for (const c of result.styles) lines.push(`  ${c.draws} newly draws ${c.selector}, which ${c.styles} only gained on this branch`);
      lines.push('A phone holding either cached half lays out nothing for it — the page still works,');
      lines.push('which is exactly the "looks like a working page" failure the version exists to prevent.');
      return lines;
    }
    lines.push('Fine if a phone holding the old half of that set is merely the app as it was.');
    lines.push('Not fine if the old half draws a control with nothing behind it — then bump the version.');
  }
  return lines;
}
