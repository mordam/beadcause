/**
 * Has somebody already filed this — the open (or closed) bead that already covers the
 * same defect, asked before a worker starts rather than discovered after.
 *
 * `bc-dgx7.106`, a session audit over four sessions that each answered "has somebody
 * already filed this?" by hand, with a different tool each time — a full `bd list
 * --status=all --json` dump piped into a one-liner, several `gh pr view`/`gh pr diff`
 * calls, a Dolt-lock timeout that fell back to `dolt sql` against the embedded DB
 * directly. Two of the four ended in `bin/supersede.js`, which is the action this answer
 * feeds: a candidate this file surfaces is not proof of a duplicate, only a lead worth a
 * human or a worker's own read before they act on it.
 *
 * **Not `lib/dupe.js`.** That module answers "is this proposed *title* a near-verbatim
 * repeat of a live one" — a 0.9 Dice-coefficient bar over word sets, meant to be strict
 * enough to run unattended at `Bd.create` and refuse or flag automatically. This answers
 * a looser, human-facing question — "is there a bead, open or already closed, that reads
 * like it is about the same thing" — over open *and* closed beads, ranked rather than
 * gated. A near-verbatim title always ranks top of this too, but this is meant to survive
 * a bead that says the same thing in different words, which `findDuplicate` is explicit
 * about not attempting.
 *
 * Nothing here spawns `bd`, `git` or `gh` — the caller already has the rows (from
 * `Bd.listAll`) and the checkout dirs (from `lib/session.js`'s `resolveSessionDir`) for
 * other reasons, same split as `lib/siblings.js` and `lib/dupe.js` before it. Attaching
 * "does a branch or PR already exist for this candidate" is the caller's job too, via
 * `lib/prior.js`'s `priorWork` — this file only ranks and scores.
 *
 * ## One weighted term vector, not three separately-summed signals — and why
 *
 * A first version scored words, files and quoted identifiers as three independent
 * signals — `similarity(words) + 6*fileOverlap + 3*quoteOverlap` — reusing
 * `lib/memory.js`'s flat, unweighted `similarity` for the word half. A live run against
 * this bead's own home tracker (`b7e-dup -w beadcause -b bc-dgx7.106`) put every other
 * `bc-dgx7.*` skill bead at the top of the ranking, ahead of anything actually about
 * duplicate detection. Two reasons, and fixing only one left the other standing:
 *
 * - **The whole `bc-dgx7.*` family shares a near-identical "what shipping it takes"
 *   wiring paragraph** (`DEFAULT_TOOL_LIST`, `package-lock.json`, `test/<name>.mjs`,
 *   copy-pasted onto every one of them; see
 *   `b7e-skill-bead-wiring-checklist-is-stale-since-bcwbrhi`), so a flat word-overlap
 *   score treats that paragraph the same as the one sentence that actually says what a
 *   bead is about.
 * - **`guessedFiles` reads that same paragraph** — it names real, existing repo paths
 *   (`lib/toolbelt.js`, `test/lockfile.mjs`) as part of the boilerplate itself — so the
 *   file-overlap signal was *reinforcing* the same false positive at 6× weight rather
 *   than correcting for it. Fixing the word half alone (TF-IDF) and leaving files a flat,
 *   un-discounted overlap fraction still left every sibling bead's shared infrastructure
 *   files outscoring a real duplicate's one shared *subject* file.
 *
 * So words, declared/guessed files and quoted identifiers now live in one term vector
 * (`termVector`, files namespaced `file:…`, quotes namespaced `quote:…`) and go through
 * one TF-IDF cosine (`weightedSimilarity`) built fresh per run over whatever pool is
 * actually being ranked (`buildIdf`) — a term nearly every candidate has, word or file,
 * is evidence of nothing; a term three candidates out of two thousand share is real, and
 * this needs no fixed stopword or "common infrastructure file" list to know which is
 * which. `tokens()` is still `lib/memory.js`'s own — same NOISE list, same 4-character
 * floor — just no longer fed straight into that module's flat `similarity`. The title
 * additionally counts for more than the body (`FIELD_WEIGHTS`): it is the one field a
 * copy-pasted checklist never touches, so it is where "what this is actually about"
 * survives even when the description is mostly boilerplate.
 */
import { tokens } from './memory.js';
import { declaredFiles, guessedFiles } from './beadfiles.js';
import { titleSimilarity, DUPE_THRESHOLD } from './dupe.js';

/** Everything about a bead that is prose, in the order a reader would meet it. */
const TEXT_FIELDS = ['title', 'description', 'design', 'notes', 'acceptance_criteria', 'acceptance'];

export function beadText(row) {
  return TEXT_FIELDS.map((f) => row?.[f]).filter(Boolean).join('\n');
}

/**
 * The declared surface if there is one, else the guessed one — `lib/beadfiles.js`'s own
 * `surfaceOf`, minus the `source` tag this file has no use for. `dirs` narrows a guess to
 * paths that really exist somewhere the bead could be worked; an empty `dirs` (the
 * checkout could not be resolved) makes this the declared surface alone, which is still
 * a real answer, just a narrower one.
 */
export function filesOf(row, dirs = []) {
  const declared = declaredFiles(row);
  if (declared.length) return declared;
  return guessedFiles(row, dirs);
}

/**
 * Backtick-quoted spans, `like this` — the identifiers, filenames and command names a
 * bead's own prose already sets off from the sentence around them. Capped at 80 chars so
 * a fenced fixture block (`beadfiles`, `decision`) accidentally read as one giant "quote"
 * cannot swamp the comparison; a span that long is a block, not an identifier.
 */
const QUOTED_RE = /`([^`\n]{1,80})`/g;
export function quotedTerms(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(QUOTED_RE)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return out;
}

/** How much each field counts toward the word half of the term vector — see module doc. */
const FIELD_WEIGHTS = { title: 4, description: 1, design: 1, notes: 1, acceptance_criteria: 1.2, acceptance: 1.2 };

/**
 * A shared file is worth more than a shared word — sharing a **file**, not just words, is
 * the single strongest signal `dv-5eu.11`'s own history has (two closed beads, `dv-52r.6`
 * and `.7`, whose only textual overlap with the querying bead was the shared filename
 * `artist-vision.json`). A shared quoted identifier is worth less than a shared file,
 * since two beads can quote the same command or filename in passing without being about
 * the same defect. Both still go through the same `buildIdf` discount as every word, so a
 * file (or identifier) the whole pool shares — the failure mode this file exists to
 * avoid — does not outweigh one only two beads have in common.
 */
export const FILE_WEIGHT = 6;
export const QUOTED_WEIGHT = 3;

/**
 * A bead's words, declared/guessed files and quoted identifiers, together, as one
 * term-frequency vector — `Map<token, weight>` — namespaced (`file:`, `quote:`) so a
 * filename can never collide with an ordinary word. Built once per bead, same reason
 * `queryFor` exists: ranking many candidates should not recompute this once per
 * comparison. `filesOverride`, when given, replaces the row's own declared/guessed
 * surface — the `--files` flag's route in, and how a query with no bead yet (`--title`
 * alone) still gets a file signal.
 */
export function termVector(row, { dirs = [], filesOverride = null } = {}) {
  const v = new Map();
  const add = (t, w) => v.set(t, (v.get(t) || 0) + w);

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const val = row?.[field];
    if (!val) continue;
    for (const t of tokens(val)) add(t, weight);
  }
  const files = filesOverride && filesOverride.length ? filesOverride : filesOf(row, dirs);
  for (const f of files) add(`file:${f}`, FILE_WEIGHT);
  for (const q of quotedTerms(beadText(row))) add(`quote:${q}`, QUOTED_WEIGHT);
  return v;
}

/**
 * Inverse document frequency of every token across `termVectors`, smoothed so a token
 * seen in every one still gets a small positive weight rather than zeroing it out
 * entirely (a term every candidate shares with the *query* — its own name, say — should
 * count for a little, not nothing). `n + 1` over `df + 1`, `+ 1` again: the standard
 * smoothed-idf shape, chosen for the property that matters here rather than tuned
 * against this tracker specifically — a term in one document out of many scores near
 * the ceiling, a term in every document scores near 1.
 */
function buildIdf(termVectors) {
  const df = new Map();
  for (const v of termVectors) {
    for (const t of v.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = termVectors.length;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  return idf;
}

/**
 * Cosine similarity over two term-frequency vectors, each component further weighted by
 * `idf` (default weight 1 for a term `buildIdf` never saw). Scaled ×10, the same range as
 * `lib/memory.js`'s `similarity`, so `CANDIDATE_FLOOR` below stays comparable to that
 * module's own `RELEVANT` floor.
 */
function weightedSimilarity(a, b, idf) {
  if (!a.size || !b.size) return 0;
  const w = (t, tf) => tf * (idf.get(t) ?? 1);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, tf] of a) na += w(t, tf) ** 2;
  for (const [t, tf] of b) nb += w(t, tf) ** 2;
  for (const [t, tf] of a) if (b.has(t)) dot += w(t, tf) * w(t, b.get(t));
  if (!na || !nb) return 0;
  return (10 * dot) / Math.sqrt(na * nb);
}

/**
 * What a query bead is asking a candidate to be compared against, computed once so
 * ranking many candidates does not retokenize the same text once per candidate.
 * `files`/`quoted` are kept alongside `terms` (not just folded into the vector) because
 * the caller wants to print *which* files and identifiers actually matched, not only a
 * number.
 */
export function queryFor(row, { files = null, dirs = [] } = {}) {
  const explicit = files && files.length ? files : null;
  return {
    id: row?.id ?? null,
    title: row?.title || '',
    terms: termVector(row, { dirs, filesOverride: explicit }),
    files: new Set(explicit || filesOf(row, dirs)),
    quoted: quotedTerms(beadText(row)),
  };
}

/** Admits a candidate whose combined term vector reads as "the same subject" — the same
 * bar `lib/memory.js`'s `RELEVANT` uses for notes, kept here because both are a 10×cosine
 * over a smoothed weighting and a correct match in this file's own fixtures scores 2 to
 * 6 while an unrelated bead tops out under 1. */
export const CANDIDATE_FLOOR = 1.6;

/**
 * Why a closed bead is still an answer, and what has to travel with it.
 *
 * `bc-dgx7.67` is the same question asked from the other end: six sessions ran `bd
 * search` at a tracker to find out whether the thing they were about to file was already
 * filed, and **four of the six answers they wanted were closed or superseded beads**.
 * `lib/dupe.js` cannot see those — its `LIVE_STATUSES` is `open`/`in_progress`/`blocked`,
 * deliberately, because the thing it guards is the *create* path and a closed bead is no
 * reason to refuse a new one. Ranking, unlike refusing, has no such excuse: `bc-1tno1`'s
 * whole outcome was `bin/supersede.js` onto `bc-xl7n.134`, and `bc-xl7n.131.1` found
 * `bc-xl7n.133` already filed *and already carrying* `superseded-by:bc-beleq` — which
 * only a `bd show` on the hit revealed.
 *
 * So a closed row must never print as a bare `[closed]`, which reads as "nothing here".
 * Three things decide whether it is still the same job, and all three are already on the
 * row `Bd.listAll` returns — no second call per candidate:
 *
 * - **`superseded-by:<id>`**, a label. The bead is a signpost to another bead, and the
 *   other one is what the caller actually wants; printing the hit without it sends them
 *   to a dead end that looks like a live one.
 * - **the close reason**, which in this repo is written by the merge queue as
 *   `Merged #737 as bb322781.` — so the pull request that closed it is *in* the reason,
 *   and `closedBy` lifts it out rather than making the caller run `gh`.
 * - **whether the titles are near-verbatim**, `lib/dupe.js`'s own bar. A candidate over
 *   `DUPE_THRESHOLD` is the `bc-j6x`/`bc-ec6` case — the same bead typed twice — and is
 *   worth saying out loud beside a cosine score that has no such meaning.
 */

/** The bead this one was superseded by, from its `superseded-by:<id>` label, or null. */
export function supersededBy(row) {
  for (const l of row?.labels || []) {
    const m = /^superseded-by:(.+)$/.exec(String(l));
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * What closed it: the reason as written, and the pull request and commit named inside it
 * when the merge queue wrote it (`Merged #737 as bb322781.`). `pr`/`sha` are null for a
 * bead closed by hand with prose, which is still a perfectly good reason to print.
 */
export function closedBy(row) {
  const reason = String(row?.close_reason || row?.closeReason || '').trim();
  if (!reason) return null;
  const pr = /#(\d+)/.exec(reason);
  const sha = /\b([0-9a-f]{7,40})\b/.exec(reason);
  return { reason, pr: pr ? Number(pr[1]) : null, sha: sha ? sha[1] : null };
}

/**
 * How near-verbatim two titles are, and whether that clears `lib/dupe.js`'s own bar —
 * the one `Bd.create` refuses on. Kept beside the cosine score rather than folded into
 * it: they answer different questions, and a caller deciding rival-or-distinct wants to
 * know which of the two is talking.
 */
export function titleVerdict(queryTitle, row) {
  const score = titleSimilarity(queryTitle || '', row?.title || '');
  return { titleScore: Math.round(score * 100) / 100, verbatim: score >= DUPE_THRESHOLD };
}

/** The statuses `lib/dupe.js` calls live — everything else here is a closed bead. */
export const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked']);
export const isClosed = (row) => !OPEN_STATUSES.has(String(row?.status || 'open'));

export function scoreCandidate(query, row, { dirs = [], idf = new Map() } = {}) {
  const rowTerms = termVector(row, { dirs });
  const score = weightedSimilarity(query.terms, rowTerms, idf);
  const rowFiles = new Set(filesOf(row, dirs));
  const rowQuoted = quotedTerms(beadText(row));
  const sharedFiles = [...query.files].filter((f) => rowFiles.has(f));
  const sharedQuoted = [...query.quoted].filter((t) => rowQuoted.has(t));
  return { score, sharedFiles, sharedQuoted };
}

/**
 * Every row scored against `query`, worst dropped, best first — unsliced, so a caller
 * comparing candidates from more than one workspace (`--also`) can score each pool
 * against its own checkout's `dirs` — a guessed file only exists relative to the repo it
 * would be guessed *in* — then merge and sort the two pools together before cutting to a
 * limit. `rows` carrying a `workspace` field rides it through onto the result unchanged;
 * this file never needs to know what a workspace is.
 */
/**
 * Shared terms in the order a reader should meet them: rarest across the pool first.
 *
 * The score already discounts a term the whole pool shares (`buildIdf`), but the printed
 * list did not, and that is a legibility bug of its own — every `bc-dgx7.*` skill bead
 * shares `lib/toolbelt.js`, `test/lockfile.mjs` and `package-lock.json` through the
 * copy-pasted wiring checklist, so an alphabetical list buries the one shared *subject*
 * file under six pieces of boilerplate and reads as "these two beads have a great deal in
 * common". Same `idf` the score used, so the ordering cannot disagree with the ranking.
 */
function rarestFirst(terms, idf, prefix) {
  return [...terms].sort((a, b) => (idf.get(`${prefix}${b}`) ?? 1) - (idf.get(`${prefix}${a}`) ?? 1));
}

export function scoreAll(query, rows, { dirs = [], floor = CANDIDATE_FLOOR, closed = true } = {}) {
  const live = (rows || [])
    .filter((row) => row && row.id && row.id !== query.id)
    .filter((row) => closed || !isClosed(row));
  const rowTerms = live.map((row) => termVector(row, { dirs }));
  const idf = buildIdf([query.terms, ...rowTerms]);

  const out = [];
  live.forEach((row, i) => {
    const score = weightedSimilarity(query.terms, rowTerms[i], idf);
    if (score < floor) return;
    const rowFiles = new Set(filesOf(row, dirs));
    const rowQuoted = quotedTerms(beadText(row));
    out.push({
      id: row.id,
      title: row.title || '',
      status: row.status || 'open',
      priority: row.priority ?? null,
      assignee: row.assignee || '',
      workspace: row.workspace || null,
      score: Math.round(score * 100) / 100,
      sharedFiles: rarestFirst([...query.files].filter((f) => rowFiles.has(f)), idf, 'file:'),
      sharedQuoted: rarestFirst([...query.quoted].filter((t) => rowQuoted.has(t)), idf, 'quote:'),
      supersededBy: supersededBy(row),
      closed: isClosed(row),
      closedBy: closedBy(row),
      ...titleVerdict(query.title, row),
    });
  });
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out;
}

/**
 * Follow every `superseded-by` chain out of the ranking, so one call ends at the bead
 * that is actually still alive.
 *
 * This is `bc-dgx7.67`'s own acceptance criterion, and both halves of it are real
 * history. `bc-1tno1` is a closed P0 whose whole outcome was `bin/supersede.js` onto
 * `bc-xl7n.134` — the same bug filed 3h43m earlier — so a ranking that names `bc-1tno1`
 * and stops has named a signpost and called it a destination. `bc-xl7n.131.1` hit the
 * same shape from the other side: its `bd search` *did* return the right bead, which was
 * already carrying `superseded-by:bc-beleq`, and only a second `bd show` on the hit
 * revealed it. A chain rather than one hop, because a bead superseded twice is not
 * special enough to need a second call either.
 *
 * Successors ride *after* the row that pointed at them and are not counted against
 * `--limit`: they are not candidates the ranking found, they are where a candidate the
 * ranking found says to go, and dropping one to stay inside a limit would lose exactly
 * the id the caller came for. A successor the pool does not hold — superseded onto a bead
 * in another tracker, or one this call did not list — is still emitted by id and marked
 * `missing`, because naming it is the whole point and a name is enough to go on.
 */
export function withSuccessors(ranked, rows, { chain = 4 } = {}) {
  const byId = new Map((rows || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const seen = new Set((ranked || []).map((c) => c.id));
  const out = [];
  for (const c of ranked || []) {
    out.push(c);
    let next = c.supersededBy;
    let from = c.id;
    for (let hop = 0; next && hop < chain; hop += 1) {
      if (seen.has(next)) break;
      seen.add(next);
      const row = byId.get(next);
      if (!row) {
        out.push({ id: next, title: '', status: 'unknown', priority: null, assignee: '', workspace: c.workspace || null, score: null, sharedFiles: [], sharedQuoted: [], supersededBy: null, closed: false, closedBy: null, titleScore: 0, verbatim: false, via: from, missing: true });
        break;
      }
      out.push({
        id: row.id,
        title: row.title || '',
        status: row.status || 'open',
        priority: row.priority ?? null,
        assignee: row.assignee || '',
        workspace: row.workspace || c.workspace || null,
        score: null,
        sharedFiles: [],
        sharedQuoted: [],
        supersededBy: supersededBy(row),
        closed: isClosed(row),
        closedBy: closedBy(row),
        titleScore: 0,
        verbatim: false,
        via: from,
        missing: false,
      });
      from = row.id;
      next = supersededBy(row);
    }
  }
  return out;
}

/** `scoreAll`, cut to `limit` — the single-corpus shortcut most callers and tests want. */
export function rankCandidates(query, rows, { dirs = [], limit = 8, floor = CANDIDATE_FLOOR, closed = true } = {}) {
  return scoreAll(query, rows, { dirs, floor, closed }).slice(0, limit);
}
