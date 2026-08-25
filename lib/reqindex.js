/**
 * The requirement graph — which requirement is carried by which files, and how we know.
 *
 * Two stores, and only one of them is authoritative. That asymmetry is the design, not an
 * implementation detail, so it is worth stating before anything else in this file.
 *
 * **The note is the truth.** `noteMerge` in lib/sessionlog.js already writes a few lines
 * onto the commit that landed a bead, on `refs/notes/beadcause`. It gains the requirement
 * ids and the files that merge actually touched. That note is anchored to a specific
 * immutable commit, is written once, and is the strongest evidence this system can ever
 * have: not "an agent thought this bead was about EN.HiddenData" but "this diff, which is
 * in main, changed these files while closing a bead that named EN.HiddenData".
 *
 * **This index is a cache.** `refs/beadcause/requirements/<token>` in the common repo,
 * one ref per product token, each holding `edges.json`. Everything in it can be rebuilt
 * from the notes by `rebuildFrom`, and the test that matters asserts exactly that. An
 * index that cannot be rebuilt is one you cannot trust after a bad write — and a bad
 * write is not hypothetical here, because what fills this is agents.
 *
 * ## Why tier 2, and why a ref per token
 *
 * lib/memory.js draws the line: tier 1 is what is true about *one codebase* and lives in
 * that codebase; tier 2 is what has no single repo it belongs to and lives in the common
 * repo. A requirement edge spans repos by construction — the requirement is written in
 * `architecture` and the files are in one of forty service checkouts — so tier 1 cannot
 * hold it, and a per-repo copy would answer "which files carry EN.HiddenData" differently
 * depending on which checkout you asked from.
 *
 * A ref **per token** rather than one ref with a tree of tokens, for the reason the
 * blackboard uses `refs/beadcause/bus/<topic>`: the compare-and-swap is per ref, so two
 * landings in two products in the same second retry against each other for no reason if
 * they share one. Sharding by token is free, and the token is already the natural key —
 * every id begins with it.
 *
 * ## Commits, not paths
 *
 * An edge is keyed on `(id, repo, commit)`. The files ride along, but the *identity* of an
 * edge is the commit, because a commit is immutable and a path is not: the file that
 * carried a requirement in June is renamed in July, and an index keyed on paths would
 * quietly lose the requirement rather than report a rename. Paths are existence-checked
 * when they are read (`edgesForFiles`), the same way lib/beadfiles.js checks a guessed
 * path — a dead path is dropped from the answer rather than deleted from the record,
 * since it was true of that commit and still is.
 *
 * No line ranges, deliberately. Lines rot within days; a file is enough to route a
 * session; and if finer ever earns its place the honest unit is an exported symbol, not a
 * range.
 *
 * ## Provenance, because coverage will never be complete
 *
 * Every edge says how it got here — `declared` (somebody forecast it before the work),
 * `observed-from-diff` (a merge proved it), `human-confirmed`. That field is what lets
 * lib/reqcoverage.js draw an honest picture, and the honest picture is the whole defence
 * against the failure that actually sinks a graph like this: one that reads as complete
 * while it is half covered.
 *
 * Nothing here is pushed and nothing here gates anything. See lib/memory.js on the first
 * and lib/beadfiles.js on the second.
 */
import path from 'node:path';
import fs from 'node:fs';
import { ensureRepo } from './commonrepo.js';
import { git, ok, refTip, writeTree, commitToRef, readRefFile, filesInMerge as filesInMergeAt } from './gitref.js';

export const REQS_PREFIX = 'refs/beadcause/requirements';
export const NOTES_REF = 'refs/notes/beadcause';
const EDGES = 'edges.json';

/** The provenances an edge may carry, weakest first. Anything else is refused. */
export const PROVENANCE = ['declared', 'observed-from-diff', 'human-confirmed'];

/** How many edges one requirement keeps. The newest are the ones anybody reads. */
const MAX_EDGES = 200;
/** How many files one edge keeps. A merge that touched 400 files has said what it can. */
const MAX_FILES = 40;

const tokenOf = (id) => String(id || '').split('.')[0] || '';
const tokenRef = (token) => `${REQS_PREFIX}/${token}`;
const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');

/** The retry lib/memory.js explains — two writers on one ref must not lose each other. */
async function cas(attempts, body) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await body();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (i + 1)));
    }
  }
  throw last;
}

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** One edge, normalised. The shape every reader below can assume. */
function edgeOf(raw) {
  const commit = clean(raw?.commit, 40);
  if (!commit) return null;
  const files = [];
  for (const f of Array.isArray(raw?.files) ? raw.files : []) {
    const file = clean(f, 300).replace(/^\.\//, '');
    if (file && !files.includes(file)) files.push(file);
    if (files.length >= MAX_FILES) break;
  }
  return {
    commit,
    repo: clean(raw?.repo, 300),
    bead: clean(raw?.bead, 60),
    workspace: clean(raw?.workspace, 60),
    files,
    provenance: PROVENANCE.includes(raw?.provenance) ? raw.provenance : 'declared',
    at: clean(raw?.at, 40) || new Date().toISOString(),
  };
}

/**
 * Re-recording one `(id, repo, commit)` — what survives from the edge already there.
 *
 * **`at` is the first time we saw it**, never the last. Otherwise `rebuildFrom` — which is
 * a repair anybody may run, twice — silently restamps the whole graph with the moment of
 * the rebuild, and the one column that says when a requirement was implemented becomes a
 * record of when somebody last ran a maintenance command. It is also what makes a rebuild
 * over a correct index a genuine no-op, which is the property test/reqindex.mjs asserts and
 * the reason the index can be called disposable.
 *
 * **Provenance only ever gets stronger.** A merge proving what a bead forecast is new
 * evidence; the forecast arriving afterwards is not, and letting it overwrite would mean a
 * late `declared` write could downgrade something a diff established.
 *
 * **An empty file list does not erase a full one**, for the same reason: two writes about
 * one commit, and the one that knows less should not win.
 */
function merged(prev, edge) {
  if (!prev) return edge;
  const rank = (p) => PROVENANCE.indexOf(p);
  return {
    ...edge,
    at: prev.at || edge.at,
    provenance: rank(prev.provenance) > rank(edge.provenance) ? prev.provenance : edge.provenance,
    files: edge.files.length ? edge.files : prev.files || [],
    bead: edge.bead || prev.bead || '',
    workspace: edge.workspace || prev.workspace || '',
  };
}

/** Everything recorded under one token, `{ id: { edges: [] } }`. */
async function readToken(cwd, token) {
  const raw = await readRefFile(cwd, tokenRef(token), EDGES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt shard is a shard to rebuild, not a crash to propagate — and rebuilding is
    // exactly what `rebuildFrom` is for. Reading it as empty is what makes that possible
    // without a repair mode.
    return {};
  }
}

/**
 * Record edges from one landing: one requirement id to one commit, with its files.
 *
 * Grouped by token so a landing that names requirements in two products is two CASes and
 * not one, and so the retry from a busy product never touches the quiet one.
 *
 * Idempotent on `(id, repo, commit)`. `notePending` in lib/advocate.js can legitimately
 * run twice over one landing — it retries until the merge commit is found — and a graph
 * that counted that twice would report two pieces of evidence where there is one.
 */
export async function record({ ids = [], repo = '', commit = '', bead = '', workspace = '', files = [], provenance = 'declared', at = null } = {}) {
  const edge = edgeOf({ repo, commit, bead, workspace, files, provenance, at });
  if (!edge) return { written: [], skipped: 'no commit' };
  const wanted = [...new Set(ids.map((i) => clean(i, 200)).filter(Boolean))];
  if (!wanted.length) return { written: [], skipped: 'no requirements' };

  const cwd = await ensureRepo();
  const byToken = new Map();
  for (const id of wanted) {
    const token = tokenOf(id);
    if (!token) continue;
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(id);
  }

  const written = [];
  for (const [token, tokenIds] of byToken) {
    await cas(8, async () => {
      const tip = await refTip(cwd, tokenRef(token));
      const tree = await readToken(cwd, token);
      for (const id of tokenIds) {
        const entry = tree[id] || { edges: [] };
        const prev = (entry.edges || []).find((e) => e.commit === edge.commit && e.repo === edge.repo) || null;
        const edges = (entry.edges || []).filter((e) => !(e.commit === edge.commit && e.repo === edge.repo));
        edges.unshift(merged(prev, edge));
        tree[id] = { edges: edges.slice(0, MAX_EDGES) };
      }
      const treeSha = await writeTree(cwd, [[EDGES, json(tree)]]);
      await commitToRef(cwd, tokenRef(token), treeSha, `requirements ${token}: ${tokenIds.join(', ')} @ ${edge.commit.slice(0, 8)}`, {
        expect: tip,
      });
    });
    written.push(...tokenIds);
  }
  return { written, skipped: '' };
}

/** Which tokens have anything recorded. */
export async function tokens() {
  const cwd = await ensureRepo();
  const out = await ok(git(cwd, ['for-each-ref', '--format=%(refname)', `${REQS_PREFIX}/`]));
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(REQS_PREFIX.length + 1))
    .sort();
}

/** Every edge recorded for one requirement, newest first. */
export async function edgesFor(id) {
  const token = tokenOf(id);
  if (!token) return [];
  const cwd = await ensureRepo();
  const tree = await readToken(cwd, token);
  return (tree[clean(id, 200)]?.edges || []).map(edgeOf).filter(Boolean);
}

/** The whole graph as `{ id: [edges] }`. What coverage and the rebuild test read. */
export async function everything() {
  const cwd = await ensureRepo();
  const out = {};
  for (const token of await tokens()) {
    const tree = await readToken(cwd, token);
    for (const [id, entry] of Object.entries(tree)) {
      out[id] = (entry?.edges || []).map(edgeOf).filter(Boolean);
    }
  }
  return out;
}

/**
 * Which requirements have ever been carried by these files — the lookup that pays.
 *
 * `dirs` is where the files would be on disk, and a path that is no longer there is left
 * out of the answer: lib/beadfiles.js's rule, for lib/beadfiles.js's reason. Passing no
 * dirs skips the check entirely, which is right for a caller that only has paths (the
 * console) and wrong for one briefing a session, which has a checkout.
 *
 * Returns `[{ id, files, edges }]`, ordered by how much of the requirement's evidence
 * these files account for — a requirement three of whose files you are about to edit is
 * more likely to be what you are working on than one where you match a single path.
 */
export async function edgesForFiles(files = [], { dirs = [] } = {}) {
  const wanted = new Set(files.map((f) => String(f || '').replace(/^\.\//, '')).filter(Boolean));
  if (!wanted.size) return [];
  const alive = (file) => !dirs.length || dirs.some((d) => existsIn(d, file));
  const graph = await everything();
  const out = [];
  for (const [id, edges] of Object.entries(graph)) {
    const hit = new Set();
    const matched = [];
    for (const edge of edges) {
      const files2 = edge.files.filter((f) => wanted.has(f) && alive(f));
      if (!files2.length) continue;
      files2.forEach((f) => hit.add(f));
      matched.push(edge);
    }
    if (hit.size) out.push({ id, files: [...hit].sort(), edges: matched });
  }
  return out.sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
}

function existsIn(dir, file) {
  try {
    return fs.statSync(path.join(dir, file)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the notes */

/** The lines this adds to a landing note, or '' when there is nothing to say. */
export function noteLines({ ids = [], files = [] } = {}) {
  const lines = [];
  const cleanIds = [...new Set(ids.map((i) => clean(i, 200)).filter(Boolean))];
  if (cleanIds.length) lines.push(`requirements: ${cleanIds.join(', ')}`);
  const cleanFiles = [...new Set(files.map((f) => clean(f, 300)).filter(Boolean))].slice(0, MAX_FILES);
  if (cleanFiles.length) lines.push(`files: ${cleanFiles.join(', ')}`);
  return lines.join('\n');
}

/** What `noteLines` wrote, read back. The parser half of the format. */
export function parseNote(text) {
  const body = String(text || '');
  const list = (key) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  const landed = /^beadcause: landed\s+(\S+?)\/(\S+)\s*$/m.exec(body);
  return {
    workspace: landed?.[1] || '',
    bead: landed?.[2] || '',
    ids: list('requirements'),
    files: list('files'),
  };
}

/**
 * Rebuild the index from a repo's notes — the property that makes the index disposable.
 *
 * Walks every commit carrying a `refs/notes/beadcause` note, re-reads the requirement
 * lines out of it, and records each one afresh. Because `record` is idempotent on
 * `(id, repo, commit)`, running this over a graph that is already correct changes
 * nothing, which is what lets it be a repair *and* a test.
 *
 * `provenance` is forced to `observed-from-diff`: a note is written at the moment a merge
 * lands, so everything reachable this way is evidence rather than forecast. That is also
 * why a rebuild does not reproduce `declared` edges — those are on beads, not in history,
 * and lib/reqdeclare.js puts them back.
 */
export async function rebuildFrom(dir, { limit = 2000 } = {}) {
  const log = await ok(git(dir, ['log', `--notes=${NOTES_REF}`, '--format=%H%x00%N%x01', `--max-count=${limit}`, '--all']));
  if (!log) return { commits: 0, edges: 0 };
  const repo = clean(dir, 300);
  let commits = 0;
  let edges = 0;
  for (const chunk of log.split('\x01')) {
    const [commit, note] = chunk.replace(/^\n+/, '').split('\0');
    if (!commit || !note || !note.trim()) continue;
    const parsed = parseNote(note);
    if (!parsed.ids.length) continue;
    commits += 1;
    const { written } = await record({
      ids: parsed.ids,
      repo,
      commit: commit.trim(),
      bead: parsed.bead,
      workspace: parsed.workspace,
      files: parsed.files,
      provenance: 'observed-from-diff',
    });
    edges += written.length;
  }
  return { commits, edges };
}

/**
 * The files one merge commit changed — what an observed edge is built from.
 *
 * The implementation moved to lib/gitref.js when lib/controlindex.js needed the same
 * answer: it is a git primitive with no opinion about what it is being asked for, and the
 * alternative was one evidence layer importing the other to find out what a commit
 * touched. Re-exported here because it is part of this module's surface and its callers
 * are not the ones who should have to know where a git helper lives.
 */
export const filesInMerge = (dir, sha) => filesInMergeAt(dir, sha, { max: MAX_FILES });
