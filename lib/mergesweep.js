/**
 * A merge landed — the one place anything asks for the sweep that reacts to it.
 *
 * `sweepConflicts` in lib/prsweep.js is what a merge leaves behind: which open pull
 * requests conflict *now*, and which of those are ours to hand to a resolver. What it
 * had no trigger for is the merge itself, and there are four doors into `main`:
 *
 * - **a tap on a delivery card** — `resolveDeliveryFor` in lib/server.js;
 * - **a tap on the PR board** — `POST /api/pr/merge`, same file, a different screen;
 * - **a worker's own merge** — `bin/deliver.js`, which is how most work lands;
 * - **the merge button on github.com** — noticed after the fact by `reconcileLanded`
 *   in lib/landed.js, which is a periodic sweep rather than an act.
 *
 * Four and not the three bc-9d37.4 asked for: that bead was written from the epic's
 * sentence ("from a card, from `beadcause-deliver` or from github.com"), and the board's
 * Merge button is a fourth way a thumb lands one. A door that does not sweep is not a gap
 * anybody would see; it is a feature that looks broken exactly on the day Adam happened to
 * merge that way. So it gets the same call as the other three.
 *
 * ## Why the doors record a merge instead of sweeping it
 *
 * Every one of them could call `sweepConflicts` where it stands. Two of them are even
 * in the daemon already. They do not, and the reason is the state that makes a resolver
 * safe: **lib/resolvers.js keeps its registry in memory**, deliberately and for good
 * reasons of its own — a window handle is worth exactly as long as the iTerm that holds
 * it. Everything it guarantees is a guarantee *within one process*:
 *
 * - one resolver per pull request, which is bc-utyr — two sessions merging `main` into
 *   the same worktree at the same time, and a commit carrying unresolved conflict
 *   markers with a perfectly ordinary merge-commit shape;
 * - two resolvers on this Mac at once, because each one runs the repo's whole gate;
 * - a queue for the rest, drained when a window closes.
 *
 * `bin/deliver.js` is a **different process**. A sweep run there starts from an empty
 * registry: it cannot see the resolver the daemon opened ten minutes ago, so it would
 * open a second window on the same pull request — the exact incident — and it would open
 * two more on top of the daemon's two. Then it calls `process.exit(0)`, taking any queue
 * it had built with it. That is not a shape a flag fixes; the registry has to be one
 * registry, and only the daemon holds it.
 *
 * So a merge writes down that it merged, and the daemon's poll cycle sweeps. Three
 * things fall out of that, and each was a requirement rather than a side effect:
 *
 * 1. **No door blocks on a sweep.** A card merge returns when the merge is done, not
 *    when a resolver window has opened — the request is one small atomic file write.
 * 2. **A sweep that fails cannot fail the merge that caused it.** They are different
 *    ticks, in different stacks, and the merge has already happened by the time the
 *    record exists.
 * 3. **Two merges into one repo cost one sweep.** Records are keyed by the repo, so the
 *    second overwrites the first and carries the higher pull request number. That is
 *    what the caps in lib/resolvers.js would have had to do anyway, done before the
 *    windows rather than after them.
 *
 * It is `lib/owed.js`'s shape and for `lib/owed.js`'s reason: `state.json` has one
 * writer and `saveState` rewrites the whole of it, and a worker session merging its own
 * pull request is not that writer. A small file of its own is where a second process is
 * allowed to leave something for the daemon.
 *
 * And it carries `lib/owed.js`'s one weakness, which is worth saying out loud rather than
 * discovering: every write here is a read-modify-write of the whole file, so two merges
 * landing in the same instant — a worker's delivery and the daemon's own tap — can cost
 * one of the two records. What that loses is a *sweep*, not a merge: one repo's branches
 * stay as conflicted as they already were, with the red chip that was always the fallback,
 * until the next merge into it. A lock would be the wrong price for that, and the file is
 * written atomically (`writeJsonAtomic`), so the failure is a lost record and never a
 * corrupt one.
 *
 * ## What a record is not
 *
 * It is not a queue of work that must happen. A sweep is a courtesy on top of a merge
 * that has already succeeded, so every record is **taken before it is acted on** and
 * never retried: a request that outlived a daemon restart, or that failed once, is not
 * re-run. The next merge into that repo sweeps it again from GitHub, which is a better
 * answer than a closure this laptop has been holding since breakfast — the same
 * argument lib/resolvers.js makes about its own queue TTL, and `STALE_MS` is that TTL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import { CONFIG_DIR } from './config.js';
import { sweepConflicts } from './prsweep.js';
import { unitFor } from './repos.js';
import { resolveSessionDir } from './session.js';
import { fileSweepCard } from './sweepcard.js';

export const MERGE_SWEEPS_PATH = path.join(CONFIG_DIR, 'merge-sweeps.json');

/**
 * How old a request may be when the daemon gets to it.
 *
 * Four hours, the same number lib/resolvers.js gives its queue and the same meaning:
 * past it, the record is not describing the present any more. The ordinary life of one
 * of these is under thirty seconds — written by a merge, taken by the next poll cycle —
 * so anything this old is a daemon that was down, and the merges it missed have been
 * followed by others.
 */
const STALE_MS = 4 * 60 * 60 * 1000;

/** Everything waiting, keyed by repo. An unreadable file reads as nothing waiting. */
export function readSweepRequests() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MERGE_SWEEPS_PATH, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    if (!rec.workspace || !rec.key) continue;
    const number = Number(rec.number);
    out[key] = {
      workspace: String(rec.workspace),
      key: String(rec.key),
      /** The merge that set this off. Null is legal — the sweep says "a pull request". */
      number: Number.isInteger(number) && number > 0 ? number : null,
      base: String(rec.base || 'main'),
      /** For the log, so a line about a window names the door the merge came through. */
      why: String(rec.why || ''),
      at: String(rec.at || ''),
    };
  }
  return out;
}

function write(records) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(MERGE_SWEEPS_PATH, records);
}

/**
 * Ask for a sweep of one repo, after a merge that has already landed in it.
 *
 * `key` is the repo unit — `climative/athena-service`, or just `beadcause` where the
 * workspace is the repo — because that is what lib/resolvers.js serialises on and what
 * `unitFor` can read back into a checkout. `number` is the pull request that merged,
 * which the resolver's brief quotes instead of claiming somebody pressed a button.
 *
 * **Never throws, whatever happens.** Every caller has merged something by the time it
 * gets here, and a delivery reported as failed over a config directory that would not
 * take a file would be this doing more damage than the conflicts it exists to clear.
 * The cost of the write failing is a red chip somebody taps, which is where this
 * started.
 */
export function requestSweep({ workspace, key, number = null, base = 'main', why = '', at = new Date().toISOString() } = {}) {
  if (!workspace || !key) return null;
  const n = Number(number);
  const rec = {
    workspace: String(workspace),
    key: String(key),
    number: Number.isInteger(n) && n > 0 ? n : null,
    base: String(base || 'main'),
    why: String(why || ''),
    at,
  };
  try {
    const records = readSweepRequests();
    const held = records[rec.key];
    // Coalesced, and the higher number wins rather than the later write: two merges into
    // one repo within a cycle are one sweep, and the one the resolver's brief should name
    // is the merge that moved the base last. `null` loses to any number for the same
    // reason — a request that could not name its pull request says less than one that can.
    if (held && Number.isInteger(held.number) && (!rec.number || held.number > rec.number)) {
      rec.number = held.number;
      rec.base = held.base || rec.base;
      rec.why = held.why || rec.why;
    }
    records[rec.key] = rec;
    write(records);
  } catch {
    return null;
  }
  return rec;
}

/**
 * Take everything waiting, leaving nothing behind.
 *
 * Taken rather than read, and taken *before* anything is swept, because a record must
 * never be able to open the same windows twice — see the header. A daemon that dies
 * between the take and the sweep loses the sweep, which is the cheap half of the trade:
 * a sweep is a reaction to a merge, and the next merge reacts again.
 */
export function takeSweepRequests() {
  const records = readSweepRequests();
  const list = Object.values(records);
  if (!list.length) return [];
  try {
    write({});
  } catch {
    // The file will be re-read next cycle and the same records taken again, which is a
    // repeated sweep rather than a lost one — `resolveFor` refuses a second window on a
    // pull request that already has one, so the repeat costs `gh` calls and nothing else.
  }
  return list;
}

/** Where a record's repo actually is, or a sentence saying why it is nowhere. */
function locate(cfg, rec) {
  const ws = (cfg.workspaces || []).find((w) => w.name === rec.workspace);
  if (!ws) return { why: `${rec.workspace} is not a configured workspace any more` };
  const unit = unitFor(cfg, rec.key);
  if (unit.problem) return { why: unit.problem };
  let dir = unit.repo?.dir || '';
  if (!dir) {
    try {
      dir = resolveSessionDir(cfg, ws);
    } catch (err) {
      return { why: `no checkout for ${rec.key} — ${String(err.message || err).split('\n')[0]}` };
    }
  }
  return { ws, unit, dir };
}

/**
 * Sweep every repo something merged in since the last cycle. One sweep each.
 *
 * Returns an outcome per record so the caller can log the ones worth a line —
 * `sweepConflicts` says what it *did* on its own, and what it cannot say is that a
 * record never reached it. Four statuses:
 *
 *   - `swept`   — it ran; `result` is the sweep's own report, refusals and all.
 *   - `stale`   — older than `STALE_MS`, so it is describing a merge, not the present.
 *   - `gone`    — the workspace or the repo it names is not configured any more.
 *   - `off`     — pull requests are turned off in config; nothing here means anything.
 *
 * A sweep that acted on something also files the card that says so — lib/sweepcard.js,
 * which is the other end of this and is called from here rather than from inside
 * `sweepConflicts` for the reason that file is separate at all: the sweep's job ends when
 * the windows are open, and what happens *in* them takes twenty minutes and outlives this
 * call. The card id lands on the outcome as `card`. It is injected for the same reason
 * `sweep` is: nothing in this repo's tests may write to a real tracker.
 *
 * Never throws for a record's sake. `sweepConflicts` does not throw at all, but this is
 * called from the poll cycle, where a rejection is the daemon's problem and not the
 * merge's.
 */
export async function sweepMerged(bd, cfg, { sweep = sweepConflicts, file = fileSweepCard, now = Date.now() } = {}) {
  const taken = takeSweepRequests();
  if (!taken.length) return [];
  const out = [];
  for (const rec of taken) {
    if (cfg?.pr?.enabled === false) {
      out.push({ ...rec, status: 'off', note: 'pull requests are disabled in config' });
      continue;
    }
    const age = rec.at ? now - new Date(rec.at).getTime() : 0;
    if (Number.isFinite(age) && age > STALE_MS) {
      out.push({ ...rec, status: 'stale', note: `it was written ${Math.round(age / 3600000)}h ago` });
      continue;
    }
    const where = locate(cfg || {}, rec);
    if (!where.ws) {
      out.push({ ...rec, status: 'gone', note: where.why });
      continue;
    }
    let result;
    try {
      result = await sweep(bd, cfg, {
        ws: where.ws,
        unit: where.unit,
        dir: where.dir,
        after: rec.number,
        base: rec.base,
      });
    } catch (err) {
      // Unreachable through `sweepConflicts`, which lands every failure in its result.
      // Kept because a sweep that started opening windows and threw halfway is a bug
      // worth a line rather than a poll cycle that stopped.
      out.push({ ...rec, status: 'swept', result: { error: String(err.message || err).split('\n')[0] } });
      continue;
    }
    let card = null;
    try {
      // After the sweep and never in front of it: the card is a summary of what the sweep
      // did, and a tracker that is mid-write must not be able to stop a window opening.
      card = await file(bd, where.ws, result, { unit: where.unit, dir: where.dir, now });
    } catch (err) {
      // Unreachable through `fileSweepCard`, which lands its own failures in the answer.
      card = { error: String(err.message || err).split('\n')[0] };
    }
    out.push({ ...rec, status: 'swept', result, card });
  }
  return out;
}

/** One line for the daemon's log, or empty when the outcome speaks for itself. */
export function describeSweepOutcome(o) {
  const where = `${o.key}${o.number ? ` after #${o.number}` : ''}`;
  // `note` and not `why`: a record's `why` is the door the merge came through, which is
  // still worth having on the outcome, and the reason it was dropped is a different fact.
  if (o.status === 'stale' || o.status === 'gone') return `dropped the sweep of ${where} — ${o.note}`;
  // Configuration rather than news. `pr.enabled: false` is somebody having turned pull
  // requests off, and a line per merge saying so would be a log telling you what you set.
  if (o.status === 'off') return '';
  if (o.result?.refused) return `did not sweep ${where} — ${o.result.refused}`;
  if (o.result?.error) return `could not sweep ${where} — ${o.result.error}`;
  // The card is the one thing the sweep's own log line cannot mention, because it does not
  // know it exists. Only its failure is worth a line: a card that filed says what it says.
  if (o.card?.error) return `swept ${where} but ${o.card.error}`;
  return '';
}
