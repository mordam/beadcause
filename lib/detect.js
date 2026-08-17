import fs from 'node:fs';
import path from 'node:path';

/**
 * *Has anything changed?* — asked cheaply enough to ask every five seconds.
 *
 * The poll cycle is the daemon's only eye on the world, and until this existed the
 * whole of it ran on one clock: `pollSeconds`, thirty by default. That number was
 * doing two incompatible jobs at once. It was the **detection latency** — a bead
 * answered in another session, a `human` label added by an agent, a reply comment —
 * and it was also the **cost ceiling**, because a sweep is one `bd human list` per
 * workspace plus a `bd comments` per conversation you are waiting on, five subprocesses
 * against an embedded Dolt that around twenty agent sessions are already fighting over.
 * Turning the clock down to five seconds would have bought the latency by paying the
 * cost six times over, all day, almost always to learn that nothing had moved.
 *
 * So the two are split. The expensive sweep keeps its thirty seconds as a **backstop**,
 * and a cheap question runs on the fast clock in front of it: *did anything write to
 * this tracker since I last looked?* When the answer is no — which is nearly every
 * beat of an idle laptop — nothing else runs at all, and the daemon's idle cost is
 * unchanged from what it was. When the answer is yes, the sweep happens within
 * `detectSeconds` of the write rather than within `pollSeconds` of it.
 *
 * **The signal is Dolt's own manifest, and the reason it works is that it is a
 * commit pointer rather than a timestamp.** Every bd write is a Dolt commit, and every
 * Dolt commit rewrites `.beads/embeddeddolt/<prefix>/.dolt/noms/manifest` — about 150
 * bytes naming the new root hash. Reading it is one `open`/`read`/`close` of a file the
 * page cache is holding anyway.
 *
 * **The manifest alone is only true of embedded Dolt, and the reason is that embedded
 * Dolt exits.** Flushing the manifest is part of a bd process ending, so under the
 * embedded engine the commit pointer is on disk by the time the command returns. A
 * `dolt sql-server` never ends: it holds the store open and defers the rewrite.
 * Measured 2026-08-17 against a server on this repo's own workspace, writing and then
 * polling the manifest: **35.19s and 35.51s** before it moved. A detector on the
 * manifest alone therefore answers *nothing moved* for half a minute on a server-mode
 * workspace, and the daemon quietly falls back to the `pollSeconds` backstop it exists
 * to improve on — the failure is graceful, invisible, and worth more than the latency
 * budget it costs.
 *
 * **So the journal is read beside it.** Dolt appends every write to a single chunk
 * journal, `<prefix>/.dolt/noms/vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (thirty-two `v`s, a
 * fixed name), and it does so *before* it ever touches the manifest — within 0.6s of
 * the write in the same measurement. Both are read and joined, so an embedded workspace
 * keeps exactly the behaviour it had and a server-mode one gains a signal that moves at
 * once. No mode detection: the file is present in every database of every workspace,
 * and the join is what makes one unconditional path correct for both.
 *
 * **What is read of the journal is its SIZE, and that is not a detail.** It is 854MB on
 * this repo's workspace, so its contents are out of the question, and its *mtime* is the
 * near-miss below in a new place: measured, ten `bd` reads under the embedded engine
 * moved the journal's mtime and left its size untouched. Size is appended to by writes
 * and by nothing else. It is monotonic between collections, which is all it needs to be
 * — the detector only ever compares against the mark immediately before it — and a
 * `bd gc` truncating it reads as one change and costs one extra sweep.
 *
 * Three near-misses are worth writing down, because each one looks like it would work:
 *
 * - **`.beads/last-touched` is not it.** It holds the last bead id bd looked at and it
 *   is rewritten *by reads* — `bd show` moves it. A detector on that file would see its
 *   own sweep as a change, sweep again, and never stop.
 * - **mtime is not it either**, for the same reason from a different direction: a read
 *   opens the manifest and the mtime moves on the whole `noms` directory. Measured on
 *   2026-08-12: the manifest's *contents* are byte-identical across `bd list`, and
 *   differ after a single `bd create`. Contents, not stat.
 * - **A `fs.watch` is not it.** It would be cheaper still, but it is a per-workspace
 *   file descriptor on a directory Dolt compacts under you, and macOS FSEvents drops
 *   into polling mode for exactly this shape anyway. A 150-byte read on a timer has no
 *   failure mode to reason about.
 *
 * **A tracker this cannot read is not an error and does not force a sweep.** A
 * workspace with no embedded Dolt, a manifest mid-rewrite, a `dir` the config never
 * carried (which is every workspace in most of the test suites): all of them answer
 * `null`, the detector reports no change, and that workspace falls back to exactly the
 * `pollSeconds` cadence it had before this file existed. The failure mode of the whole
 * mechanism is therefore *the old behaviour*, which is the only failure mode worth
 * having in something that decides whether the daemon looks at all.
 */

/** Where a workspace's Dolt databases live, under its `.beads` directory. */
const DOLT = 'embeddeddolt';

/** The manifest, relative to one database directory under `embeddeddolt/`. */
const MANIFEST = ['.dolt', 'noms', 'manifest'];

/**
 * The chunk journal, relative to the same directory. Thirty-two `v`s is Dolt's own
 * fixed name for it, not a hash — every database has exactly this file.
 */
const JOURNAL = ['.dolt', 'noms', 'vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv'];

/**
 * The manifest paths inside one workspace, or `[]`.
 *
 * A workspace normally holds exactly one database — the prefix directory, `bc` or
 * `cl` — but the layout allows several and a workspace that grew a second one must
 * not go undetected in the first, so every one found is read and the marks are joined.
 */
function manifests(dir) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, DOLT));
  } catch {
    // No embedded Dolt here: a different bd backend, or a `dir` that is not a beads
    // workspace at all. Neither is a failure — see the header.
    return [];
  }
  return names
    .sort()
    .map((name) => ({
      manifest: path.join(dir, DOLT, name, ...MANIFEST),
      journal: path.join(dir, DOLT, name, ...JOURNAL),
    }));
}

/**
 * What a workspace's trackers currently say, or `null` if they cannot be read.
 *
 * The value is opaque and is only ever compared with an earlier one from the same
 * workspace. It is the manifest text rather than a hash of it because it is already
 * short, and because "which root hash was it?" is a question worth being able to answer
 * from a log line when this misbehaves.
 */
export function trackerMark(ws) {
  const dir = ws?.dir;
  if (!dir) return null;
  const marks = [];
  for (const db of manifests(dir)) {
    try {
      marks.push(fs.readFileSync(db.manifest, 'utf8'));
    } catch {
      // One unreadable database out of several is still a partial answer, and a
      // partial answer that changes is still a change. Skipping it keeps the mark
      // stable across a compaction rather than flapping the whole workspace to null.
    }
    try {
      // Size, never mtime and never the bytes — see the header. A server-mode
      // workspace moves this within a second of a write and moves the manifest
      // about thirty-five seconds later, so this is the half that carries the
      // latency budget there; on embedded Dolt the manifest above still moves first
      // and this one just agrees with it.
      marks.push(String(fs.statSync(db.journal).size));
    } catch {
      // Same reasoning as the manifest: a database whose journal cannot be read is
      // one contributor missing from a joined mark, not a workspace with no answer.
    }
  }
  // A separator rather than a bare concatenation: two contributors that both moved
  // could otherwise join to the same string as before — and with a journal size beside
  // each manifest that is no longer hypothetical, since a size is just digits and
  // `123` + `4` reads the same as `12` + `34`. A printable separator also keeps the
  // mark readable in the log line that names it.
  return marks.length ? marks.join(' + ') : null;
}

/**
 * Remembers what each workspace last said, and answers which of them have moved.
 *
 * `mark` is injectable so a suite can drive it without a Dolt on disk; nothing else
 * passes it.
 */
export function createChangeDetector({ mark = trackerMark } = {}) {
  const seen = new Map();

  /**
   * The names of the workspaces written to since the last call, updating the baseline
   * as it goes.
   *
   * **A workspace is never reported on the first sight of it**, whether that first
   * sight is at boot or the first time it became readable. There is nothing to compare
   * against, and reporting a change would mean a daemon that swept the instant it came
   * up — which the poller deliberately does not do, because the first sweep is the one
   * that would notify you about the whole backlog.
   */
  function moved(workspaces = []) {
    const out = [];
    for (const ws of workspaces) {
      const now = mark(ws);
      // An unreadable tracker keeps whatever baseline it had rather than clearing it,
      // so a manifest caught mid-rewrite costs one skipped beat and not a spurious
      // sweep on the next one.
      if (now === null) continue;
      const had = seen.get(ws.name);
      seen.set(ws.name, now);
      if (had !== undefined && had !== now) out.push(ws.name);
    }
    return out;
  }

  return { moved };
}

/**
 * How often the cheap question is asked, in milliseconds.
 *
 * Five seconds by default, which is the acceptance criterion it exists to meet rather
 * than a tuned number: the budget says a change is on the phone within five seconds,
 * and this is the first of the two hops.
 *
 * **Clamped up to one second and down to `pollSeconds`.** The floor is there because
 * the read is cheap but not free and nothing is served by asking ten times a second;
 * the ceiling is what makes `detectSeconds: <pollSeconds>` mean *turn this off* — set
 * them equal and every beat is a full cycle, which is exactly the behaviour that
 * shipped before this existed.
 */
export function detectIntervalMs(cfg = {}) {
  const poll = Math.max(5, Number(cfg.pollSeconds) || 30);
  const want = Number(cfg.detectSeconds);
  const detect = Number.isFinite(want) && want > 0 ? want : 5;
  return Math.max(1, Math.min(detect, poll)) * 1000;
}
