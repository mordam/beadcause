/**
 * The control graph — which control a merge exercised, and how we know.
 *
 * lib/reqindex.js is the sibling that proved this shape for requirements, and the
 * asymmetry it states is the design here too, so it is worth restating before anything
 * else in this file.
 *
 * **The note is the truth.** `noteMerge` in lib/sessionlog.js writes a few lines onto the
 * commit that landed a bead, on `refs/notes/beadcause`. It gains a `controls:` line. That
 * note is anchored to a specific immutable commit, is written once, and is the strongest
 * evidence this system can ever have: not "an agent thought this bead was about access
 * control" but "this diff, which is in main, changed these files while closing a bead that
 * named `SOC2.CC6.1`". An auditor's word for the difference is *operating effectiveness*,
 * and the reason it is worth this much machinery is that it is the half of a compliance
 * programme nobody can produce afterwards.
 *
 * **This index is a cache.** `refs/beadcause/controls/<framework>` in the common repo, one
 * ref per framework, each holding `edges.json`. Everything in it is rebuildable from the
 * notes by {@link rebuildFrom}, and test/controlindex.mjs asserts exactly that by wiping
 * the store and rebuilding. An index that cannot be rebuilt is one you cannot trust after
 * a bad write — and a bad write is not hypothetical here, because what fills this is
 * agents.
 *
 * ## Forecast and proof are the same edge with a different provenance
 *
 * `declared` is a bead saying beforehand what it will exercise. `observed-from-diff` is a
 * merge having done it. `human-confirmed` is somebody having looked. The distinction is
 * the whole point rather than a nicety: a control programme that counts intentions as
 * evidence is a programme that reads as complete on the morning of the audit and has
 * nothing to show for any of it. lib/controlcoverage.js counts the two apart and says so
 * on every line it prints.
 *
 * Provenance only ever gets **stronger** on re-record, for the reason {@link merged}
 * gives: a late forecast must not downgrade something a diff already established.
 *
 * ## Sharded by framework, keyed on commits
 *
 * A ref per framework rather than one ref for everything, for lib/reqindex.js's reason:
 * the compare-and-swap is per ref, so two landings in the same second retry against each
 * other for no reason if they share one. The framework token is already the first segment
 * of every control id — `SOC2.CC6.1`, `ISO42001.A.6.2.8` — because lib/controls.js put it
 * there rather than beside the id, so the shard key needs no second field and cannot
 * disagree with the id it shards.
 *
 * An edge is keyed on `(id, repo, commit)`. The files ride along, but the *identity* is
 * the commit: a commit is immutable and a path is not, and an index keyed on paths would
 * quietly lose a control rather than report a rename.
 *
 * ## Why this is not lib/reqindex.js with a different constant
 *
 * The mechanics rhyme and the meanings do not. A requirement edge answers *what
 * implements this* and degrades to nothing on an install with no corpus. A control edge
 * answers *what evidences this*, the corpus always exists, and the answer is read by an
 * internal-audit instrument that has to be able to say a control has **no** evidence —
 * which requires the denominator to be a closed set that is always there. Fusing the two
 * would mean one module whose absent-corpus branch is correct for one caller and a lie for
 * the other. They share lib/gitref.js, which is where the part that is genuinely the same
 * already lives.
 *
 * Nothing here is pushed and nothing here gates anything.
 */
import path from 'node:path';
import fs from 'node:fs';
import { ensureRepo } from './commonrepo.js';
import { git, ok, refTip, writeTree, commitToRef, readRefFile } from './gitref.js';
import { frameworkOf } from './controls.js';

export const CONTROLS_PREFIX = 'refs/beadcause/controls';
export const NOTES_REF = 'refs/notes/beadcause';
const EDGES = 'edges.json';

/** The provenances an edge may carry, weakest first. Anything else is refused. */
export const PROVENANCE = ['declared', 'observed-from-diff', 'human-confirmed'];

/** The provenances that are evidence rather than intention. lib/controlcoverage.js's rule. */
export const PROVING = ['observed-from-diff', 'human-confirmed'];

/** How many edges one control keeps. The newest are the ones anybody reads. */
const MAX_EDGES = 200;
/** How many files one edge keeps. A merge that touched 400 files has said what it can. */
const MAX_FILES = 40;

/**
 * The shard a control id belongs in.
 *
 * `frameworkOf` rather than `id.split('.')[0]`, so an id naming a framework the corpus does
 * not have gets no ref of its own: a typo would otherwise mint
 * `refs/beadcause/controls/SCO2` and the graph would carry a shard nothing can ever read
 * back through the corpus. Callers are expected to have run the id past `keepControls`
 * already; this is the second door, on the write side, where a ref would be created.
 */
const shardOf = (id) => frameworkOf(id) || '';
const shardRef = (token) => `${CONTROLS_PREFIX}/${token}`;
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
 * **`at` is the first time we saw it**, never the last. This matters more here than it does
 * for a requirement, because `at` is what lib/controlcoverage.js measures a review period
 * against: restamping it on every rebuild would make every control look freshly evidenced
 * the moment somebody ran a repair command, which is the exact failure — a control that
 * reads as current because the *index* was touched, not because the control was operated.
 *
 * **Provenance only ever gets stronger.** A merge proving what a bead forecast is new
 * evidence; the forecast arriving afterwards is not.
 *
 * **An empty file list does not erase a full one**: two writes about one commit, and the
 * one that knows less should not win.
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

/** Everything recorded under one framework, `{ id: { edges: [] } }`. */
async function readShard(cwd, token) {
  const raw = await readRefFile(cwd, shardRef(token), EDGES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt shard is a shard to rebuild, not a crash to propagate — and rebuilding is
    // exactly what `rebuildFrom` is for.
    return {};
  }
}

/**
 * Record edges from one landing: one control id to one commit, with its files.
 *
 * Grouped by framework so a landing naming a SOC 2 criterion and a 42001 control is two
 * compare-and-swaps and not one, and so the retry from a busy framework never touches the
 * quiet one.
 *
 * Idempotent on `(id, repo, commit)`. `notePending` in lib/advocate.js can legitimately run
 * twice over one landing — it retries until the merge commit is found — and a graph that
 * counted that twice would report two pieces of evidence where there is one, which for a
 * control is not a cosmetic error but an overstated sample.
 */
export async function record({
  ids = [],
  repo = '',
  commit = '',
  bead = '',
  workspace = '',
  files = [],
  provenance = 'declared',
  at = null,
} = {}) {
  const edge = edgeOf({ repo, commit, bead, workspace, files, provenance, at });
  if (!edge) return { written: [], skipped: 'no commit' };
  const wanted = [...new Set(ids.map((i) => clean(i, 200)).filter(Boolean))];
  if (!wanted.length) return { written: [], skipped: 'no controls' };

  const byShard = new Map();
  for (const id of wanted) {
    const token = shardOf(id);
    if (!token) continue;
    if (!byShard.has(token)) byShard.set(token, []);
    byShard.get(token).push(id);
  }
  if (!byShard.size) return { written: [], skipped: 'no framework' };

  const cwd = await ensureRepo();
  const written = [];
  for (const [token, shardIds] of byShard) {
    await cas(8, async () => {
      const tip = await refTip(cwd, shardRef(token));
      const tree = await readShard(cwd, token);
      for (const id of shardIds) {
        const entry = tree[id] || { edges: [] };
        const prev = (entry.edges || []).find((e) => e.commit === edge.commit && e.repo === edge.repo) || null;
        const edges = (entry.edges || []).filter((e) => !(e.commit === edge.commit && e.repo === edge.repo));
        edges.unshift(merged(prev, edge));
        tree[id] = { edges: edges.slice(0, MAX_EDGES) };
      }
      const treeSha = await writeTree(cwd, [[EDGES, json(tree)]]);
      await commitToRef(cwd, shardRef(token), treeSha, `controls ${token}: ${shardIds.join(', ')} @ ${edge.commit.slice(0, 8)}`, {
        expect: tip,
      });
    });
    written.push(...shardIds);
  }
  return { written, skipped: '' };
}

/** Which frameworks have anything recorded. */
export async function shards() {
  const cwd = await ensureRepo();
  const out = await ok(git(cwd, ['for-each-ref', '--format=%(refname)', `${CONTROLS_PREFIX}/`]));
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(CONTROLS_PREFIX.length + 1))
    .sort();
}

/** Every edge recorded for one control, newest first. */
export async function edgesFor(id) {
  const token = shardOf(id);
  if (!token) return [];
  const cwd = await ensureRepo();
  const tree = await readShard(cwd, token);
  return (tree[clean(id, 200)]?.edges || []).map(edgeOf).filter(Boolean);
}

/** The whole graph as `{ id: [edges] }`. What coverage and the rebuild test read. */
export async function everything() {
  const cwd = await ensureRepo();
  const out = {};
  for (const token of await shards()) {
    const tree = await readShard(cwd, token);
    for (const [id, entry] of Object.entries(tree)) {
      out[id] = (entry?.edges || []).map(edgeOf).filter(Boolean);
    }
  }
  return out;
}

/**
 * Which controls have ever been evidenced by these files — the reverse lookup.
 *
 * `dirs` is where the files would be on disk, and a path that is no longer there is left
 * out of the answer: lib/beadfiles.js's rule, for lib/beadfiles.js's reason. Passing no
 * dirs skips the check entirely, which is right for a caller that only has paths and wrong
 * for one standing in a checkout.
 *
 * Returns `[{ id, files, edges }]`, ordered by how much of the control's evidence these
 * files account for.
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
      const here = edge.files.filter((f) => wanted.has(f) && alive(f));
      if (!here.length) continue;
      here.forEach((f) => hit.add(f));
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

/**
 * When a commit landed, as an ISO string — the date an edge recorded against it is `at`.
 *
 * **Not `new Date()`, and this is the difference between a review clock and a decoration.**
 * lib/reqindex.js stamps an edge with the moment it was written, which is fine for a lookup
 * that only ever answers *which files*. Here `at` is measured against an observation window
 * by lib/controlcoverage.js, so it has to be the moment the evidence was produced. Two
 * things fall out of taking it from the commit, and both matter:
 *
 * - a wipe-and-`rebuildFrom` reproduces the graph **exactly**, including the clock. A note
 *   does not carry a date, so a rebuild that stamped today would mark all 192 controls
 *   freshly evidenced on the day somebody ran a repair — the one failure a staleness
 *   report cannot survive, because it is indistinguishable from good news.
 * - a landing noted late — `notePending` retries until the merge commit is found, which
 *   can be hours — is dated when it merged rather than when the daemon noticed.
 *
 * Null when the commit cannot be read, and the caller then falls back to now: an edge with
 * no date at all would be invisible to every window.
 */
export async function commitDate(dir, sha) {
  const out = await ok(git(dir, ['log', '-1', '--format=%cI', sha]));
  return out?.trim() || null;
}

/* ------------------------------------------------------------------ the notes */

/**
 * The `controls:` line this adds to a landing note, or '' when there is nothing to say.
 *
 * **No `files:` line, on purpose.** lib/reqindex.js's `noteLines` already writes one and
 * `parseNote` on both sides reads the *first* match of a key, so a note carrying two would
 * silently pick one and the other would be dead text that looks authoritative. There is one
 * file list per landing because there is one diff per landing; lib/controllanding.js is
 * what composes the note and what adds the `files:` line when the requirements half did
 * not.
 */
export function noteLines({ ids = [] } = {}) {
  const cleanIds = [...new Set(ids.map((i) => clean(i, 200)).filter(Boolean))];
  return cleanIds.length ? `controls: ${cleanIds.join(', ')}` : '';
}

/** The `files:` line, which either half of the landing may own. See `noteLines`. */
export function fileLines({ files = [] } = {}) {
  const cleanFiles = [...new Set(files.map((f) => clean(f, 300)).filter(Boolean))].slice(0, MAX_FILES);
  return cleanFiles.length ? `files: ${cleanFiles.join(', ')}` : '';
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
    ids: list('controls'),
    files: list('files'),
  };
}

/**
 * Rebuild the index from a repo's notes — the property that makes the index disposable.
 *
 * Walks every commit carrying a `refs/notes/beadcause` note, re-reads the `controls:` line
 * out of it, and records each one afresh. Because {@link record} is idempotent on
 * `(id, repo, commit)` and {@link merged} keeps the first `at`, running this over a graph
 * that is already correct changes nothing — which is what lets it be a repair *and* a
 * test, and what keeps a repair from restamping the review clock on 192 controls.
 *
 * `provenance` is forced to `observed-from-diff`: a note is written at the moment a merge
 * lands, so everything reachable this way is evidence rather than forecast. A rebuild
 * therefore does not reproduce `declared` edges — those live on beads, not in history, and
 * a bead that has not landed still has its block.
 *
 * `at` comes off the commit rather than off the clock, which is what makes this a genuine
 * restore rather than an approximate one — see {@link commitDate}.
 */
export async function rebuildFrom(dir, { limit = 2000 } = {}) {
  const log = await ok(git(dir, ['log', `--notes=${NOTES_REF}`, '--format=%H%x00%cI%x00%N%x01', `--max-count=${limit}`, '--all']));
  if (!log) return { commits: 0, edges: 0 };
  const repo = clean(dir, 300);
  let commits = 0;
  let edges = 0;
  for (const chunk of log.split('\x01')) {
    const [commit, at, note] = chunk.replace(/^\n+/, '').split('\0');
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
      at: (at || '').trim() || null,
    });
    edges += written.length;
  }
  return { commits, edges };
}
