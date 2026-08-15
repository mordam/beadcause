/**
 * Finding the records lib/changesample.js reasons about.
 *
 * Split from that file rather than sitting in it, for the reason lib/reqcoverage.js is
 * split from lib/reqindex.js: everything in `changesample.js` is a pure function of data,
 * and a test that has to stand up a config directory, a tracker and a git repository
 * before it can assert that a missing merge bead reads as `absent` is a test nobody
 * writes the fourth case of. The pure half imports nothing at all; this half imports the
 * five modules that know where the records live, and does the one thing they cannot do
 * for themselves — ask all of them about the same change.
 *
 * ## Three questions, three calls, whatever the size of the window
 *
 * A quarter of this repository is a few hundred changes, and the shape that kills a report
 * like this is per-row lookup: one `bd show` per sampled change is fine, one per *change
 * in the population* is a few hundred processes, and the tool becomes something you run
 * once and never again. So the tracker is read whole, once (`listAll`), and indexed in
 * memory by the three keys the rows are joined on — bead id, pull request number for the
 * merge bead, pull request number for the ship bead. Git is one `log` and one
 * `for-each-ref`. The cost of a quarter and the cost of a week are the same.
 *
 * ## What a failure here must not look like
 *
 * A tracker that cannot be read is not a change-management failure, and the report must
 * never say it is. Every reader below fails to `null`, and `null` reaches
 * `evidenceFor` as `asked: false` — six `unknown`s and a line at the top of the report
 * saying the tracker could not be reached. The alternative is an artefact that reports a
 * quarter of clean changes as a quarter of findings because the daemon happened to be
 * mid-write, and an artefact that can do that once cannot be trusted the other times.
 */
import { git, ok, mainCheckout } from './gitref.js';
import { archivedBeads } from './sessionlog.js';
import { isMergeBead, mergeSpec } from './mergebead.js';
import { markerOf, loadLedger, SHIP_LABEL } from './release.js';
import { population, evidenceFor, exceptionsOf, sampleOf, tally } from './changesample.js';

/**
 * The record separator. `%N` is a note body and carries newlines, so the fields are
 * NUL-separated and the records are separated by RS — the two characters git will never
 * put in a subject, a date or a note of its own accord.
 */
const RS = '\x1e';
/**
 * `%cI` and deliberately not `%aI`.
 *
 * A squash merge keeps the *author* date of the work and stamps the *committer* date at
 * the moment it landed, and those are days apart on a branch that waited. The window this
 * report is about is when a change reached production, so the committer date is the one
 * that belongs in the row — and it is also the one `--since` and `--until` filter on, so
 * taking the author date would print a date the window boundary disagreed with, which is
 * the sort of thing an auditor notices and cannot unsee.
 */
const FORMAT = `${RS}%H%x00%cI%x00%s%x00%N`;

/**
 * Every commit on `branch` in the window, newest first, with its beadcause note.
 *
 * `--first-parent` because the population is pull requests, and the commits inside a
 * merged branch are the session's own working history — real commits, individually
 * unapproved, and counting them as changes would inflate the denominator with rows that
 * were never separately anything. On a squash-merge repository the flag changes nothing
 * and costs nothing; on one that takes merge commits it is the difference between 200
 * changes and 2,000.
 */
export async function commitsIn(main, { branch = 'main', from = '', to = '' } = {}) {
  const args = ['log', '--first-parent', '--notes=beadcause', `--format=${FORMAT}`];
  if (from) args.push(`--since=${from}`);
  if (to) args.push(`--until=${to}`);
  args.push(branch, '--');
  const out = await ok(git(main, args));
  if (!out) return [];
  return out
    .split(RS)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [commit, at, subject, ...rest] = rec.split('\0');
      return { commit: (commit || '').trim(), at: (at || '').trim(), subject: (subject || '').trim(), note: rest.join('\0') };
    })
    .filter((c) => c.commit);
}

/** `owner/repo` from the origin remote, locally and offline. Null when there is none. */
export async function slugOf(main) {
  const url = await ok(git(main, ['remote', 'get-url', 'origin']));
  const m = /github\.com[/:]([^/]+\/[^/\s.]+)/.exec(String(url || '').trim());
  return m ? m[1] : null;
}

/**
 * The tracker, read once and turned into the three indexes the join needs.
 *
 * `null` — not an empty index — when it could not be read. The difference is the whole of
 * the note at the top of this file: an empty index answers every question "absent", and a
 * null answers every question "we did not ask".
 */
export async function trackerIndex(bd, workspace) {
  if (!bd || !workspace) return null;
  let rows;
  try {
    rows = await bd.listAll(workspace);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const beads = new Map();
  const merges = new Map();
  const ships = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    beads.set(String(row.id), row);
    if (isMergeBead(row)) {
      const spec = mergeSpec(row);
      // A block that will not parse is skipped rather than counted: `mergeSpec` reports
      // that case as `{error}` and a bead with no readable number cannot be joined to a
      // change at all. It is not silently lost — the change it belonged to comes out as
      // `absent` on `approved`, which is exactly the row worth looking at by hand.
      if (spec && !spec.error && Number.isInteger(spec.number)) {
        merges.set(spec.number, {
          id: String(row.id),
          status: String(row.status || ''),
          tests: String(spec.tests || ''),
          bead: spec.bead || null,
        });
      }
    }
    if ((row.labels || []).some((l) => String(l).trim() === SHIP_LABEL)) {
      const marker = markerOf([row.description, row.design, row.notes].filter(Boolean).join('\n'));
      if (marker) {
        ships.set(marker.number, {
          id: String(row.id),
          status: String(row.status || ''),
          closeReason: String(row.close_reason || row.closeReason || ''),
        });
      }
    }
  }
  return { beads, merges, ships };
}

/**
 * What the release ledger says a workspace shipped, by pull request number.
 *
 * The ledger is a **local file with a retention limit** — 45 days, `KEEP_DAYS` in
 * lib/release.js — where every other record here is permanent. That is not a detail to
 * hide behind a lookup: a SOC 2 Type II observation window is three months at the short
 * end, so a sample taken at the end of one asks this file about deployments it has
 * already pruned, and gets `unknown` for changes that certainly shipped. `since` is
 * carried out with the index so the report can say that in the one place a reader would
 * otherwise conclude the deployments never happened.
 */
export function ledgerIndex(workspace) {
  const ledger = loadLedger();
  const entry = ledger && workspace?.name ? ledger[workspace.name] : null;
  const handled = entry?.handled && typeof entry.handled === 'object' ? entry.handled : {};
  const by = new Map();
  for (const [number, row] of Object.entries(handled)) {
    const n = Number(number);
    if (Number.isInteger(n) && row && typeof row === 'object') by.set(n, row);
  }
  return { by, since: entry?.since || null, readable: ledger !== null };
}

/**
 * The whole artefact: the population, the evidence, the sample and the totals.
 *
 * Evidence is computed for **every** change and not only the sampled ones. It costs
 * nothing once the three indexes are in memory, and it is what makes `--size 0` — the
 * whole period rather than a sample of it — the same code path rather than a second one.
 * A sample nobody can widen is a sample an auditor will not believe.
 */
export async function collect({
  dir,
  bd = null,
  workspace = null,
  branch = 'main',
  from = '',
  to = '',
  size = 25,
  seed = 1,
  generatedAt = new Date().toISOString(),
} = {}) {
  const main = (await ok(mainCheckout(dir))) || dir;
  const [commits, head, slug, archived, index] = await Promise.all([
    commitsIn(main, { branch, from, to }),
    ok(git(main, ['rev-parse', branch])).then((v) => String(v || '').trim()),
    slugOf(main),
    archivedBeads(main).catch(() => new Set()),
    trackerIndex(bd, workspace),
  ]);

  const ledger = ledgerIndex(workspace);
  const { changes, strays } = population(commits);
  for (const change of changes) {
    change.evidence = evidenceFor(change, {
      bead: change.bead ? index?.beads.get(change.bead) || null : null,
      merge: index?.merges.get(change.pr) || null,
      ship: index?.ships.get(change.pr) || null,
      release: ledger.by.get(change.pr) || null,
      archived: change.bead ? archived.has(change.bead) : false,
      asked: !!index,
    });
    change.exceptions = exceptionsOf(change.evidence);
  }

  const sample = sampleOf(changes, { size, seed });
  return {
    generatedAt,
    repo: slug,
    prUrl: slug ? `https://github.com/${slug}/pull/` : null,
    branch,
    head,
    from,
    to,
    seed,
    asked: !!index,
    /** When the release ledger's own record begins — see `ledgerIndex`. */
    ledgerSince: ledger.since,
    population: changes.length,
    changes,
    strays,
    sample,
    totals: tally(sample),
  };
}
