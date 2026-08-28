/**
 * A workspace's beads and comments, read off its own Dolt tables directly, cached on
 * disk, and filtered in process — the thing `bin/b7e-graph` is a thin wrapper around.
 *
 * bc-dgx7.98. **The problem this exists for is not that `bd list` lacks filters** — by
 * the time this landed, `bd list` had grown `--title-contains`, `--assignee`, `--label`,
 * `--status` and `--parent` natively, and `bd show <id1,id2,...>` takes a list and
 * `--include-comments` streams full bodies in one call. **It is that every one of those
 * still goes through `bd`'s own Dolt access layer**, and under real concurrent load that
 * layer is what falls over: `dv-3rn.2` (quoted in full in the bead) had `bd show`/`bd
 * comments` calls hang for five minutes at a time, `ps` showing 48 concurrent `bd`
 * processes, while a *raw* `dolt sql -q "describe comments"` against the same database
 * from the same shell answered in under a second. That gap — a `dolt sql` CLI read never
 * takes whatever lock `bd`'s own query path contends on — is the entire reason this
 * module reads the tables itself instead of shelling out to `bd`.
 *
 * **What "identical to `bd list --status=all --json`" means here, precisely, because it
 * cannot mean everything that phrase could mean.** `bd list --json` also computes
 * `dependency_count`/`dependent_count` (aggregates over the full `dependencies` table),
 * a `dependencies[]` array, and lease bookkeeping (`started_at`, `lease_expires_at`,
 * `heartbeat_at`, from a separate `leases` table `bd` joins in at read time) — none of
 * that is reproduced here. What this module returns is: every column `issues` itself
 * carries (`id`, `title`, `description`, `design`, `acceptance_criteria`, `notes`,
 * `status`, `priority` as a number, `issue_type`, `assignee`, `owner`, `created_at`,
 * `created_by`, `updated_at`, `closed_at`, `close_reason`), plus `labels` (sorted, from
 * the `labels` table), `parent` (the one `parent-child` edge naming this issue as the
 * child, or `null`), `comment_count`, and `comments[]` (from the `comments` table, in
 * `created_at` order) — verified field-for-field equal to the same fields in `bd list
 * --status=all --json` for the same rows, in test/beadsnapshot.mjs, on a real `bd init`
 * fixture. That is the honest scope: a fast local read of what a bead *is*, not a
 * reimplementation of `bd`'s query planner.
 *
 * **Never a write, and never a WHERE clause built from user input.** Every fetch below
 * is an unconditional `select *` (well, an explicit column list) over a whole table —
 * no filter value from a caller ever reaches a SQL string, because there is nothing to
 * escape if it never gets there. All filtering (`--title-match`, `--assignee`, `--label`,
 * `--status`, `--parent`, `--closed-reason`) happens in `filterIssues`, over the plain
 * JS array the snapshot already built.
 *
 * **The cache lives outside the repo and outside `~/.config/beadcause` on purpose.** It
 * is a disposable read cache, not durable state: a `dolt sql` read plus a `JSON.stringify`
 * away from being rebuilt from nothing at any moment. Landing it under `~/.config/
 * beadcause` would mean an evidence-register entry, a NOT_EVIDENCE exemption or a
 * retention decision, a commonrepo gitignore line and a test/memory.mjs churn assertion —
 * four writes ([[a-new-state-file-under-config-dir-owes-four-writes]]) for a file whose
 * entire purpose is to vanish and be rebuilt. `os.tmpdir()` needs none of that, and losing
 * it on a reboot is not a bug — see [[beadcause-scratchpad-dir-is-not-gitignored]] for the
 * same "disposable things go outside the tracked tree" rule applied to a different case.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { trackerMark } from './detect.js';
import { writeJsonAtomic } from './atomic.js';

const DOLT_SUBDIR = 'embeddeddolt';

function defaultExec(bin, args, opts) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * "YYYY-MM-DD HH:MM:SS" (what `dolt sql -r json` prints for a `datetime` column) as
 * "YYYY-MM-DDTHH:MM:SSZ" (what `bd`'s own JSON prints for the same column) — verified
 * byte-for-byte equal against a real `bd show --json` for the same row. `null`/`''`
 * pass straight through; Dolt prints SQL NULL as JSON `null`, never as an empty string,
 * for a `datetime` column, but this is defensive rather than load-bearing.
 */
export function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  return `${String(v).replace(' ', 'T')}Z`;
}

/**
 * Every Dolt database under `<beadsDir>/embeddeddolt/` — normally exactly one (the
 * workspace's id prefix, `bc` or `cl`), but the layout allows more than one and a
 * workspace that grew a second must not go unread in the first. Mirrors `manifests()`
 * in lib/detect.js, which reads the same directory for the same reason (a workspace's
 * change signal) but does not export a databases-only view, hence the small duplication
 * here rather than a reach into that module's private helper.
 */
export function databases(beadsDir) {
  const root = path.join(beadsDir, DOLT_SUBDIR);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return fs.statSync(path.join(root, name, '.dolt')).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((prefix) => ({ prefix, dir: path.join(root, prefix) }));
}

/**
 * `select <cols>` (a fixed literal, never interpolated from a caller) over the whole of
 * `table`, run with `dolt sql -r json` from inside `dbDir`. Returns `.rows`, or `[]` for
 * an empty table — `dolt sql -r json` omits the `rows` key entirely rather than printing
 * `{"rows":[]}` when nothing matches, which is the one shape a bare `JSON.parse(...).rows`
 * would throw on.
 */
function selectAll(dbDir, table, cols, { exec = defaultExec, doltBin = 'dolt' } = {}) {
  const sql = `select ${cols.join(', ')} from ${table}`;
  let out;
  try {
    out = exec(doltBin, ['sql', '-r', 'json', '-q', sql], { cwd: dbDir });
  } catch (err) {
    throw new Error(`b7e-graph: \`dolt sql\` against ${dbDir} failed: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`b7e-graph: \`dolt sql\` against ${dbDir} printed non-JSON output for "select ... from ${table}"`);
  }
  return parsed.rows || [];
}

const ISSUE_COLS = [
  'id',
  'title',
  'description',
  'design',
  'acceptance_criteria',
  'notes',
  'status',
  'priority',
  'issue_type',
  'assignee',
  'owner',
  'created_at',
  'created_by',
  'updated_at',
  'closed_at',
  'close_reason',
];

/**
 * Every issue, label, comment and `parent-child` edge in every database under
 * `beadsDir`, joined into one row per issue. No caching here — that is `loadSnapshot`'s
 * job, one layer up, so this stays a pure "read it all, right now" function a test can
 * call directly against a fixture without reasoning about staleness at all.
 */
export function buildSnapshot(beadsDir, opts = {}) {
  const dbs = databases(beadsDir);
  const issues = [];
  const prefixes = [];
  for (const db of dbs) {
    prefixes.push(db.prefix);
    const issueRows = selectAll(db.dir, 'issues', ISSUE_COLS, opts);
    const labelRows = selectAll(db.dir, 'labels', ['issue_id', 'label'], opts);
    const commentRows = selectAll(db.dir, 'comments', ['id', 'issue_id', 'author', 'text', 'created_at'], opts);

    const labelsByIssue = new Map();
    for (const r of labelRows) {
      if (!labelsByIssue.has(r.issue_id)) labelsByIssue.set(r.issue_id, []);
      labelsByIssue.get(r.issue_id).push(r.label);
    }
    for (const arr of labelsByIssue.values()) arr.sort();

    const commentsByIssue = new Map();
    for (const r of commentRows) {
      if (!commentsByIssue.has(r.issue_id)) commentsByIssue.set(r.issue_id, []);
      commentsByIssue.get(r.issue_id).push({
        id: r.id,
        issue_id: r.issue_id,
        author: r.author,
        text: r.text,
        created_at: isoDate(r.created_at),
      });
    }
    for (const arr of commentsByIssue.values()) arr.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    const parentByIssue = new Map();
    for (const r of selectAllParentEdges(db.dir, opts)) parentByIssue.set(r.issue_id, r.parent_id);

    for (const row of issueRows) {
      issues.push({
        id: row.id,
        title: row.title,
        description: row.description,
        design: row.design,
        acceptance_criteria: row.acceptance_criteria,
        notes: row.notes,
        status: row.status,
        priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
        issue_type: row.issue_type,
        assignee: row.assignee,
        owner: row.owner,
        created_at: isoDate(row.created_at),
        created_by: row.created_by,
        updated_at: isoDate(row.updated_at),
        closed_at: isoDate(row.closed_at),
        close_reason: row.close_reason,
        labels: labelsByIssue.get(row.id) || [],
        parent: parentByIssue.get(row.id) || null,
        comment_count: (commentsByIssue.get(row.id) || []).length,
        comments: commentsByIssue.get(row.id) || [],
      });
    }
  }
  return { takenAt: new Date().toISOString(), prefixes, issues };
}

/** The one `parent-child` edge naming each issue as the child — `issue_id` is the
 * child, `depends_on_issue_id` is the parent, verified against `bd show`'s own
 * dependency rows for a real parent/child pair (see the module header). A plain
 * literal `where` clause, not built from any caller input. */
function selectAllParentEdges(dbDir, opts) {
  const sql = "select issue_id, depends_on_issue_id as parent_id from dependencies where type = 'parent-child'";
  const { exec = defaultExec, doltBin = 'dolt' } = opts;
  let out;
  try {
    out = exec(doltBin, ['sql', '-r', 'json', '-q', sql], { cwd: dbDir });
  } catch (err) {
    throw new Error(`b7e-graph: \`dolt sql\` against ${dbDir} failed: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`b7e-graph: \`dolt sql\` against ${dbDir} printed non-JSON output reading parent edges`);
  }
  return parsed.rows || [];
}

/** Where the cached snapshot for `beadsDir` lives — outside the repo, outside
 * `~/.config/beadcause`, keyed by the resolved absolute path so two workspaces never
 * collide and the same workspace always finds its own cache regardless of cwd. */
export function cachePath(beadsDir) {
  const key = crypto.createHash('sha1').update(path.resolve(beadsDir)).digest('hex').slice(0, 20);
  return path.join(os.tmpdir(), 'b7e-graph-cache', `${key}.json`);
}

/**
 * The snapshot for `beadsDir` — from the on-disk cache if it is fresh, freshly built
 * and written back otherwise.
 *
 * "Fresh" is two independent checks, either one of which forces a rebuild: `maxAgeMs`
 * (a wall-clock ceiling — `--max-age` on the command line) and `trackerMark` (Dolt's own
 * manifest + journal signal, from lib/detect.js, reused as-is rather than reinvented —
 * see that module's header for why it is cheap and honest). A workspace nobody has
 * written to in an hour answers instantly from cache even with a five-minute
 * `maxAgeMs`, because the mark has not moved; one bd write invalidates it immediately
 * regardless of `maxAgeMs`, because the point of the mark check is to not need a short
 * `maxAgeMs` at all.
 */
export function loadSnapshot(beadsDir, { maxAgeMs = 5 * 60 * 1000, force = false, now = () => Date.now(), mark = trackerMark, ...execOpts } = {}) {
  const file = cachePath(beadsDir);
  const currentMark = mark({ dir: beadsDir });
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Age is measured against `takenAtMs` — stamped by the same `now()` this call
      // was given — never against `snapshot.takenAt`, which is a real wall-clock
      // `toISOString()` for humans to read and is not itself injectable. Comparing
      // an injected clock against a real one is exactly the bug this file used to
      // have: a fake `now()` starting near epoch made every cache read forever in
      // the future, so "stale" never fired.
      const age = now() - Number(cached.takenAtMs);
      if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs && cached.mark === currentMark) {
        return { ...cached.snapshot, fresh: false, cached: true };
      }
    } catch {
      // Missing, unreadable, or the wrong shape — rebuild exactly as if this were
      // the first call. Nothing here is durable state; a cache that cannot be read
      // is no different from a cache that has never been written.
    }
  }
  const takenAtMs = now();
  const snapshot = buildSnapshot(beadsDir, execOpts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { takenAtMs, mark: currentMark, snapshot });
  } catch {
    // A cache write that fails (a read-only tmpdir, a full disk) must not fail the
    // read that triggered it — the snapshot just gets rebuilt again next call.
  }
  return { ...snapshot, fresh: true, cached: false };
}

/**
 * `issues`, narrowed to whichever of these predicates are given — every one given must
 * match (AND). `label` and `status` are arrays: `label` is ANDed (must carry every one
 * named, matching `bd list --label`'s own semantics), `status` is ORed (matching `bd
 * list --status a,b`'s comma-separated form).
 */
export function filterIssues(
  issues,
  { titleMatch = null, assignee = null, label = [], status = [], parent = null, closedReason = null } = {}
) {
  const wantTitle = titleMatch ? titleMatch.toLowerCase() : null;
  const wantAssignee = assignee ? assignee.toLowerCase() : null;
  const wantClosedReason = closedReason ? closedReason.toLowerCase() : null;
  const wantLabels = label || [];
  const wantStatuses = (status || []).map((s) => s.toLowerCase());
  return issues.filter((issue) => {
    if (wantTitle && !String(issue.title || '').toLowerCase().includes(wantTitle)) return false;
    if (wantAssignee && String(issue.assignee || '').toLowerCase() !== wantAssignee) return false;
    if (wantLabels.length && !wantLabels.every((l) => issue.labels.includes(l))) return false;
    if (wantStatuses.length && !wantStatuses.includes(String(issue.status || '').toLowerCase())) return false;
    if (parent && issue.parent !== parent) return false;
    if (wantClosedReason && !String(issue.close_reason || '').toLowerCase().includes(wantClosedReason)) return false;
    return true;
  });
}

/** id, status, assignee, labels, title — the columns the bead itself names, padded
 * into a plain table. Title is the last column and is never truncated: it is the
 * thing being read, and a terminal wraps a long line on its own. */
export function formatTable(issues) {
  if (!issues.length) return '(no matching beads)';
  const idW = Math.max(2, ...issues.map((i) => String(i.id).length));
  const statusW = Math.max(6, ...issues.map((i) => String(i.status || '').length));
  const assigneeW = Math.max(8, ...issues.map((i) => String(i.assignee || '').length));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const lines = [`${pad('id', idW)}  ${pad('status', statusW)}  ${pad('assignee', assigneeW)}  labels / title`];
  for (const i of issues) {
    const labels = i.labels.length ? `[${i.labels.join(',')}] ` : '';
    lines.push(`${pad(i.id, idW)}  ${pad(i.status, statusW)}  ${pad(i.assignee || '', assigneeW)}  ${labels}${i.title}`);
  }
  return lines.join('\n');
}

/** `issues`, ready for `JSON.stringify` — `comments` dropped unless `withComments`,
 * since fetching them into the snapshot is free (one read, already done) but printing
 * them by default would make every plain query as noisy as `--with-comments`. */
export function forJson(issues, { withComments = false } = {}) {
  if (withComments) return issues;
  return issues.map(({ comments, ...rest }) => {
    void comments;
    return rest;
  });
}
