/**
 * The requirements corpus — the closed vocabulary everything else here is checked against.
 *
 * Climative records acceptance criteria as **requirements**, in YAML, in the architecture
 * repo: `resources/reqs/{product,technical}/*.yaml`, today 34 files and about 280 ids.
 * Each id is `TOKEN.Feature.Thing`, carries a `definition`, and often names the Playwright
 * spec that covers it. That vocabulary is the whole reason bc-fvmx is tractable: a
 * requirement id is a **closed set**, so an id that does not resolve is a typo or an
 * invention and can be refused at the door rather than stored and believed.
 *
 * **Refusing is the entire job of this file.** An advocate asked to name requirement ids
 * before they have been minted will invent them — and a fabricated
 * `EN.HomeownerPortal.Hidden` sitting beside the real `EN.HomeownerPortal.HiddenData` is
 * two nodes in the graph forever, with nothing to tell them apart. It is the same failure
 * lib/edits.js argues about with matching an epic by its title: the wrong one is silent,
 * survives, and is only visible much later as a graph that quietly stopped meaning
 * anything. So: parse the corpus, hand out the set, and let lib/beadreqs.js drop anything
 * that is not in it.
 *
 * ## Why this parses YAML by hand
 *
 * Two reasons, and the second is the real one. The corpus is 1500 lines, read whole and
 * cached — a parser dependency for that is the expensive direction. But more to the
 * point, **half of these files are not valid YAML** and the ones that are do not agree on
 * a shape:
 *
 * - `auth-service` puts ids under `requirements:` with a nested `definition:`.
 * - `energy-navigator-backend` has no `requirements:` key at all: the ids are top-level
 *   and the definition is inline on the id line.
 * - `energy-advisor` is two documents in one file, separated by `===` rather than `---`,
 *   with a different `token:` on each side.
 * - `climative-data-platform` writes `CDPDS:` and then nests `.client:` → `.auth:` under
 *   it, so an id is the concatenation of a path rather than a key.
 * - `example-template` is a template, and its "ids" are angle-bracket placeholders.
 *
 * A strict parser rejects the file it cannot read, and a rejected file is a set of
 * requirements that silently do not exist — which, in a system whose only defence is
 * "this id is not in the corpus", turns every id in that file into a fabrication. So the
 * reader here is line-based and forgiving by construction: it takes what it recognises
 * and steps over the rest, and a malformed line costs one requirement rather than a file.
 *
 * **The token is what makes an id an id.** Every document declares one, and a key is a
 * requirement only if it is that token or extends it. That is what separates
 * `EN.HomeownerPortal.HiddenData` from `feature`, `description` and `reference` without a
 * keyword list that goes stale the day somebody adds a field — and it is what makes the
 * template file yield nothing at all, since `<SOME_ALPHABETA_TOKEN_NO_SPACES>` is not a
 * token by the shape of it.
 *
 * ## The spec links are half the value
 *
 * `Test case:` is a markdown link into `Climative/test-automation`, sometimes a list of
 * them. It is parsed rather than kept as prose because the join it makes possible is the
 * one concrete payoff of the whole epic: invert requirement→file (lib/reqindex.js) and a
 * session about to edit a file can be told *which of a large e2e suite must still pass*.
 * That answer already exists in the corpus and nothing has ever been able to reach it.
 *
 * ## An absent corpus is an answer
 *
 * A Mac without the architecture checkout gets `{}`, every caller degrades to knowing no
 * requirements, and nothing throws. That is the same guarantee lib/ownership.js makes for
 * an install that does not know who it is: the feature is off, byte for byte, rather than
 * broken — because this rides in *another repo* that most of these repos have no reason
 * to have on disk.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where a checkout keeps them, relative to its root. One spelling, used three ways. */
export const CORPUS_SUBDIR = path.join('resources', 'reqs');

/**
 * A token, by its shape.
 *
 * Letters and digits, starting with a letter — `EN`, `CDPDS`, `platform`. Deliberately
 * not "whatever follows `token:`", because `example-template.yaml` follows it with
 * `<SOME_ALPHABETA_TOKEN_NO_SPACES>` and a corpus that accepted that would hand every
 * caller a set of placeholder ids to validate against.
 */
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `key: value`, with the indent, for a line that is not a list item or a comment. */
const KEY_RE = /^(\s*)([^\s#][^:]*?):[ \t]*(.*?)\s*$/;

/** A markdown link, which is how every `Test case:` in the corpus names its spec. */
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/** The field names that carry a definition, in the spellings the corpus actually uses. */
const DEFINITION_KEYS = new Set(['definition', 'definitions', 'desc']);

/** The field names that carry a spec link. `Test case` is the one in use; the rest are insurance. */
const SPEC_KEYS = new Set(['test case', 'test cases', 'testcase', 'test']);

/** How much of one definition is kept. A brief quotes these; a page-long one is a document. */
const MAX_DEFINITION = 1200;

/** A block scalar introducer — `|`, `>`, and their chomping and indentation variants. */
const isBlockScalar = (v) => /^[|>][-+0-9]*$/.test(v);

const indentOf = (line) => line.length - line.trimStart().length;

/** The specs a `Test case:` value names, as `{ name, url }`. Bare filenames count too. */
function specsIn(value) {
  const out = [];
  const seen = new Set();
  const text = String(value || '');
  for (const hit of text.matchAll(LINK_RE)) {
    const name = hit[1].trim();
    const url = hit[2].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url });
  }
  if (!out.length) {
    // A spec named without a link — rarer, and still the useful half of the answer.
    for (const hit of text.matchAll(/[\w.-]+\.spec\.[jt]s/g)) {
      if (seen.has(hit[0])) continue;
      seen.add(hit[0]);
      out.push({ name: hit[0], url: '' });
    }
  }
  return out;
}

/**
 * One file's requirements.
 *
 * A single pass with a stack of `{ indent, id }`, because the only structure that matters
 * here is which key a nested key hangs off. Everything else — documents, comments, block
 * scalars, the file that uses `===` where YAML wants `---` — is handled by recognising a
 * line or ignoring it, never by failing.
 *
 * The stack is what makes `CDPDS:` → `.client:` → `.auth:` come out as
 * `CDPDS.client.auth`: a key beginning with a dot is not a key, it is a suffix on
 * whatever is directly above it. That shape is one file's habit rather than a convention,
 * which is exactly why it has to be read rather than corrected — the ids in the tracker
 * will be written the way the corpus spells them.
 */
export function parseCorpusText(text, file = '') {
  const lines = String(text || '').split('\n');
  const out = new Map();
  /** The document's token. Reset by every `token:` line, because one file may hold two. */
  let token = '';
  /** `{ indent, id }` for each key we are inside, outermost first. */
  const stack = [];
  /** Set while consuming a `|` block, so its body is not read as keys. */
  let block = null;

  const record = (id, patch) => {
    if (!id) return;
    const prev = out.get(id) || { id, token, file, definition: '', specs: [] };
    const next = { ...prev, ...patch };
    if (patch.definition) next.definition = String(patch.definition).trim().slice(0, MAX_DEFINITION);
    if (patch.specs?.length) next.specs = [...prev.specs, ...patch.specs.filter((s) => !prev.specs.some((p) => p.name === s.name))];
    out.set(id, next);
  };

  /**
   * Close off a definition block, splitting out a `Test case:` that was indented into it.
   *
   * `EN.SignIn.Options` writes its spec link one level too deep, so it lands *inside* the
   * `definition: |` scalar rather than beside it — which made the corpus's own count of
   * `Test case` keys (18) disagree with the number of requirements that had a spec (17),
   * and left one definition with a markdown URL glued onto the end of its last sentence.
   * A block scalar swallows whatever is indented under it; recognising the key on the way
   * out is the only place this can be corrected, and it costs one regexp on a string that
   * has already been assembled.
   */
  const closeBlock = () => {
    if (!block) return;
    const body = block.body.join('\n');
    const at = body.search(/^[ \t]*test cases?[ \t]*:/im);
    const definition = (at === -1 ? body : body.slice(0, at)).replace(/\s+/g, ' ').trim();
    if (definition) record(block.id, { definition });
    if (at !== -1) {
      const specs = specsIn(body.slice(at));
      if (specs.length) record(block.id, { specs });
    }
    block = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, '    ');

    // Inside a block scalar: everything indented past its key belongs to it.
    if (block) {
      if (!line.trim() || indentOf(line) > block.indent) {
        block.body.push(line.slice(Math.min(indentOf(line), block.indent + 4)));
        continue;
      }
      closeBlock();
    }

    if (!line.trim() || line.trim().startsWith('#')) continue;

    // A list item under `Test case:` — the one place the corpus uses a sequence.
    if (/^\s*-\s/.test(line)) {
      const top = stack[stack.length - 1];
      const specs = specsIn(line);
      if (top && specs.length) record(top.id, { specs });
      continue;
    }

    const m = KEY_RE.exec(line);
    if (!m) {
      // A definition written as a bare line under its id, with no `definition:` key at
      // all — `Service-area-management.yaml` does this for every one of its requirements.
      // Only where there is an id directly above it and it has said nothing yet, so a
      // stray line elsewhere in a file cannot become somebody's acceptance criterion.
      const top = stack[stack.length - 1];
      if (top && indentOf(line) > top.indent && !line.includes(':') && !out.get(top.id)?.definition) {
        record(top.id, { definition: line.trim() });
      }
      continue;
    }
    const [, pad, rawKey, value] = m;
    const indent = pad.length;
    const key = rawKey.trim();

    if (/^(?:---|===)/.test(key)) continue;

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] || null;

    if (key === 'token') {
      // A new document in the same file. Its ids hang off nothing above it.
      token = TOKEN_RE.test(value) ? value : '';
      stack.length = 0;
      continue;
    }

    const lower = key.toLowerCase();
    if (parent && DEFINITION_KEYS.has(lower)) {
      // An empty value opens a block exactly as `|` does, because in this corpus it
      // usually *is* one: `AREA.application.personas` writes its definition as a list of
      // roles on the lines beneath, with no scalar marker. Read strictly, those three
      // requirements came out with an empty definition and were filed as stubs — which is
      // the expensive direction, since a stub reads as "nobody has written this yet" when
      // in fact somebody wrote three paragraphs of it. `IBR.fuel-type-x`, which genuinely
      // has nothing beneath it, collects an empty body and stays a stub.
      if (isBlockScalar(value) || !value) block = { id: parent.id, indent, body: [] };
      else record(parent.id, { definition: value });
      continue;
    }
    if (parent && SPEC_KEYS.has(lower)) {
      const specs = specsIn(value);
      if (specs.length) record(parent.id, { specs });
      // An empty value means the links are in the list items below, which the branch
      // above catches — the parent is still on the stack, which is what it needs.
      continue;
    }

    // Is this key a requirement, or one of the file's own fields?
    let id = '';
    if (key.startsWith('.') && parent) id = `${parent.id}${key}`;
    else if (token && (key === token || key.startsWith(`${token}.`) || key.startsWith(`${token}-`))) id = key;
    if (!id) continue;

    // A key something else hangs off is a heading, not a requirement — `CDPDS:` above
    // `.client:`. Marked as it happens rather than inferred afterwards, because the only
    // evidence is that a child extended it.
    if (key.startsWith('.') && parent) record(parent.id, { container: true });
    stack.push({ indent, id });
    if (isBlockScalar(value)) block = { id, indent, body: [] };
    else if (value) record(id, { definition: value });
    else if (!out.has(id)) record(id, {});
  }

  closeBlock();

  // A key that turned out to be only a heading — `CDPDS:` above `.client:` — is nothing
  // anybody can fulfil, and is dropped. An id with **no definition and no children** is a
  // different thing and is kept as a stub: `IBR.fuel-type-x` is a real id somebody wrote
  // down and has not filled in yet, and refusing it as an invention would be the one
  // failure this file exists to prevent, pointed the wrong way.
  for (const [id, entry] of out) {
    if (entry.container && !entry.definition) out.delete(id);
    else if (!entry.definition) out.set(id, { ...entry, stub: true });
  }
  return out;
}

/** Every `.yaml`/`.yml` under a directory, one level of subdirectories deep. */
function corpusFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth > 0) walk(p, depth - 1);
      } else if (/\.ya?ml$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir, 2);
  return out;
}

/**
 * The corpus, cached on what the files say about themselves.
 *
 * Keyed by directory and invalidated by the newest mtime and the file count together —
 * either alone misses a case (a file edited in place, a file deleted) and the pair is one
 * `stat` per file on a corpus this size. The advocate asks for this on every sweep, and a
 * re-read per sweep would be 34 file reads for an answer that changes about weekly.
 */
const cache = new Map();

/**
 * Load the corpus from a directory — the architecture checkout, or its `resources/reqs`.
 *
 * Both spellings are accepted because both are what a caller has: config names a checkout,
 * lib/repos.js knows repo roots, and a human debugging this types the path to the YAML.
 * Returns `{ ids, byToken, tokens, files, dir }` with `ids` a Map, and an empty one for a
 * directory that is not there — see the header: absent is an answer.
 *
 * **The returned object is shared and must be treated as read-only.** It is the cached
 * value, handed to every caller in the process; writing into its `ids` changes what the
 * advocate, the brief and the console all see, and nothing would say why. A caller that
 * needs a corpus with something extra in it builds a new object around the same Map.
 */
export function loadCorpus(dir) {
  const empty = { ids: new Map(), byToken: new Map(), tokens: [], files: [], duplicates: [], dir: dir || null };
  if (!dir) return empty;
  const root = fs.existsSync(path.join(dir, CORPUS_SUBDIR)) ? path.join(dir, CORPUS_SUBDIR) : dir;
  const files = corpusFiles(root);
  if (!files.length) return { ...empty, dir: root };

  let stamp = `${files.length}`;
  for (const f of files) {
    try {
      stamp += `:${fs.statSync(f).mtimeMs}`;
    } catch {
      stamp += ':0';
    }
  }
  const hit = cache.get(root);
  if (hit && hit.stamp === stamp) return hit.corpus;

  const ids = new Map();
  /**
   * Ids defined twice — a corpus bug, reported rather than resolved.
   *
   * `audit-service` and `auth-service` both declare `token: AS` and both define
   * `AS.authentication` with different definitions. First writer wins, because the
   * alternative — last writer wins — makes which definition you get depend on the order
   * `readdir` happened to return, and that is worse in the same way silently either way.
   *
   * But winning quietly is its own failure: one of the two requirements is then invisible,
   * an edge recorded against the id means whichever of them the reader assumed, and
   * nothing anywhere says there was a choice. So the losing pairs are kept and surfaced —
   * on the coverage screen and in `beadcause-requirements corpus` — which is the same
   * thing lib/repos.js does with a duplicate service token rather than picking one.
   */
  const duplicates = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const [id, entry] of parseCorpusText(text, path.relative(root, f))) {
      if (!ids.has(id)) ids.set(id, entry);
      else duplicates.push({ id, kept: ids.get(id).file, ignored: entry.file });
    }
  }

  const byToken = new Map();
  for (const entry of ids.values()) {
    if (!byToken.has(entry.token)) byToken.set(entry.token, []);
    byToken.get(entry.token).push(entry);
  }
  const corpus = {
    ids,
    byToken,
    tokens: [...byToken.keys()].sort(),
    files: files.map((f) => path.relative(root, f)),
    duplicates,
    dir: root,
  };
  cache.set(root, { stamp, corpus });
  return corpus;
}

/** Forget what was cached. For tests, and for a CLI that just rewrote a YAML file. */
export function forgetCorpus() {
  cache.clear();
}

/**
 * Where the corpus might be, given what beadcause already knows about repos.
 *
 * Config first if it names one, then `resources/reqs` inside any repo directory this
 * install has been told about. The second is not a guess dressed up: the corpus lives in
 * the architecture checkout, which *is* one of the repos work happens in, so the path is
 * derived from something already configured rather than from a constant with somebody's
 * home directory in it.
 */
export function corpusDir(cfg = {}, dirs = []) {
  const named = String(cfg?.requirements?.corpus || '').trim();
  if (named && fs.existsSync(named)) return named;
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, CORPUS_SUBDIR);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Is this a requirement anybody has written down? The one question everything else asks. */
export const isRequirement = (corpus, id) => Boolean(corpus?.ids?.has(String(id || '').trim()));

/** One requirement, or null. */
export const requirement = (corpus, id) => corpus?.ids?.get(String(id || '').trim()) || null;

/**
 * The requirement ids written in a piece of prose.
 *
 * Matched by shape and then kept only if the corpus has them, which is the same two-step
 * lib/beadfiles.js uses for a path in a description: the regexp says "this looks like
 * one", and the disk — here, the corpus — says whether it is. Without the second step
 * this would find `EN.route` in a sentence about routing.
 */
export function idsIn(text, corpus) {
  const out = [];
  const seen = new Set();
  for (const hit of String(text || '').matchAll(/\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+\b/g)) {
    const id = hit[0];
    if (seen.has(id)) continue;
    seen.add(id);
    if (isRequirement(corpus, id)) out.push(id);
  }
  return out;
}
