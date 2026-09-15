/**
 * Four steps every delivered run ends with, sequenced once instead of by hand five
 * times over — see `bin/b7e-signoff`.
 *
 * `bc-dgx7.44`: a session audit found the same four steps at the end of five sessions
 * (`bc-1kwl.32`, `bc-ibt8g.1`, `bc-xl7n.120`, `bc-xl7n.118`, `bc-36xx.27`), no two of
 * them doing it the same way. The pull request (`bin/deliver.js`), the debrief
 * (`beadcause-memory debrief`), and the rename (`~/.claude/rename-session.sh`) are all
 * real tools that already worked; nothing sequenced them, so the two traps that keep
 * costing sessions time — deliver refusing to run from the main checkout, and prose
 * with a backtick in it being resolved by the shell before the command ever sees it —
 * were rediscovered on almost every run.
 *
 * This module holds the parts worth testing without a real `gh`, a real tracker or a
 * real `~/.claude/sessions/<pid>.json`: which worktree a bead's own branch is sitting
 * in, what a queued session's new name is, what the closing marker line says, what
 * `bin/deliver.js`'s own last line of output meant, and a tiny sequencer that runs a
 * list of named steps and stops — without touching the ones after it — the moment one
 * of them throws. `bin/b7e-signoff` is the thin CLI that wires real subprocesses
 * (`node bin/deliver.js`, `~/.claude/rename-session.sh`) and the real
 * `lib/memory.js#debrief` into that sequencer.
 */
import path from 'node:path';
import { git, ok } from './gitref.js';
import { parseWorktrees, realPath } from './tidy.js';
import { tagOf, ownsBranch } from './notinmain.js';
import { saidFinished } from './reap.js';
import { QUEUED_PREFIX } from './retitle.js';

const WORKTREES_DIR = path.join('.claude', 'worktrees');

const under = (p, root) => p === root || p.startsWith(root + path.sep);

/**
 * Every live worktree of `main` — registered at the path git actually recorded, under
 * `.claude/worktrees/`, not `.claude/worktrees-retired/` and not the main checkout
 * itself. See `worktree-state-is-not-a-name-lookup`: a retired worktree is still a
 * fully registered one, so "live" is a claim about the *path*, never about the name.
 */
export async function liveWorktrees(main) {
  const wtRoot = realPath(path.join(main, WORKTREES_DIR));
  const porcelain = await ok(git(main, ['worktree', 'list', '--porcelain']));
  if (!porcelain) return [];
  return parseWorktrees(porcelain).filter((w) => w.branch && !w.detached && under(realPath(w.path), wtRoot));
}

/**
 * Which of `entries` (already filtered to live worktrees) is `beadId`'s own — the one
 * whose branch is `worktree-<slug>-<tag>` where `<tag>` is this bead's id with the
 * workspace prefix and punctuation stripped. See `a-beads-own-branch-is-its-id-tag`.
 *
 * `cwd`, when given, is preferred over the registry: a session already sitting inside
 * its own worktree (the ordinary case — a worker's shell cwd is the worktree from the
 * moment `EnterWorktree` ran) should never have to walk the whole worktree list to
 * confirm what it already knows. It is only ever used to *pick among* candidates that
 * `ownsBranch` already agreed belong to this bead — never to accept a worktree the
 * branch tag does not own.
 *
 * Throws, naming what it looked for, on zero matches or more than one — a refusal here
 * is what stops this ever reaching `bin/deliver.js`'s own "refusing to open a PR from
 * main into main": that refusal only fires once deliver is handed a directory, and this
 * runs first.
 */
export function chooseWorktree(entries, beadId, { main, cwd = null } = {}) {
  const tag = tagOf(beadId);
  const owned = entries.filter((w) => ownsBranch(beadId, w.branch));

  if (cwd) {
    const here = realPath(cwd);
    const mine = owned.find((w) => under(here, realPath(w.path)));
    if (mine) return { dir: mine.path, branch: mine.branch, matched: 'cwd' };
  }

  if (owned.length === 1) return { dir: owned[0].path, branch: owned[0].branch, matched: 'unique' };

  if (owned.length === 0) {
    const wtRoot = path.join(main, WORKTREES_DIR);
    throw new Error(
      `no live worktree claims ${beadId} — looked under ${wtRoot} for a branch ending "-${tag}" ` +
        `(worktree-<slug>-${tag}), and none of the ${entries.length} registered live worktree` +
        `${entries.length === 1 ? '' : 's'} matched. Pass --dir to deliver from somewhere else.`
    );
  }

  throw new Error(
    `${owned.length} live worktrees claim ${beadId}'s branch tag "-${tag}" — ` +
      `${owned.map((w) => `${w.path} (${w.branch})`).join(', ')}. Pass --dir to pick one.`
  );
}

/**
 * The name this session should carry once its delivery is queued — never landed, that
 * is `mergedTitle` in `lib/retitle.js` and it is not this command's to write.
 *
 * `null` means "leave it — say so, do not write anything": a name already carrying
 * `QUEUED-` or `DONE-` (`saidFinished`, case-insensitive) is a re-run of this command
 * on a session that already renamed itself, and stacking a second prefix on top is the
 * one bug this function exists to make impossible. Everything else about the name is
 * untouched — this only ever adds the prefix, never re-derives the rest of it, which is
 * the whole fix for "the title hand-truncated to a different length each time and cut
 * mid-word": there is nothing here left to truncate.
 */
export function queuedTitle(currentName) {
  const raw = String(currentName || '').trim();
  if (!raw) return null;
  if (saidFinished(raw)) return null;
  return `${QUEUED_PREFIX}${raw}`;
}

/**
 * The fallback, for the one case `queuedTitle` cannot help with: no current name to
 * prepend to at all (a session with no `~/.claude/sessions/<pid>.json` resolvable, or a
 * test harness with no window backing it). Built from the bead's own title, in full —
 * never hand-shortened, which is the other half of the same historical bug.
 */
export function fallbackTitle(beadId, beadTitle) {
  const title = String(beadTitle || '').trim();
  return `${QUEUED_PREFIX}Beadcause - ${beadId}${title ? ` ${title}` : ''}`;
}

/**
 * `** BEAD WORK DONE ** …` — the line every worker brief in this repo ends a delivered
 * run with. `owed` is the list of steps the merge has not been through yet (a subset of
 * `DEPLOYED`/`REBUILT`/`REVIEWED`, in the order the caller gave them); an empty list is
 * the other honest ending, `CLOSED`.
 */
export function markerLine(owed = []) {
  const words = (owed || []).map((w) => String(w).trim()).filter(Boolean);
  return `** BEAD WORK DONE ** CAN BE ${words.length ? words.join(', ') : 'CLOSED'} **`;
}

/**
 * `bin/deliver.js`'s own last line of output, read back rather than re-derived — three
 * shapes, one per ending (see its own header):
 *
 *   queued #123 https://…/pull/123 cl-abc     — on the merge queue
 *   landed #123 https://…/pull/123 a1b2c3d4    — already merged on GitHub
 *   cl-xyz https://…/pull/123                  — a question card; nothing merges yet
 *
 * `outcome` is `'queued' | 'landed' | 'asked'`. Only `'asked'` changes what this
 * command does next — see the header on `bin/b7e-signoff` for why the marker is
 * overridden to `REVIEWED` in that case and nowhere else.
 */
export function parseDeliverOutcome(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  let m = /^queued\s+(#\d+)\s+(\S+)\s+(\S+)/.exec(last);
  if (m) return { outcome: 'queued', pr: m[1], url: m[2], mergeBead: m[3], line: last };
  m = /^landed\s+(#\d+)\s+(\S+)(?:\s+(\S+))?/.exec(last);
  if (m) return { outcome: 'landed', pr: m[1], url: m[2], sha: m[3] || '', line: last };
  m = /^(\S+)\s+(\S+)/.exec(last);
  if (m) return { outcome: 'asked', questionId: m[1], url: m[2], line: last };
  return { outcome: 'unknown', line: last };
}

/**
 * A question card is the one ending nothing has merged from — see `bin/deliver.js`'s
 * own rule ("nothing after the merge can be owed by work that has not merged"). This is
 * that rule, applied here rather than re-argued: an `--marker` naming anything but
 * `REVIEWED` over an `asked` outcome is corrected, loudly, not silently accepted.
 */
export function ownedMarkerFor(outcome, requested) {
  const words = (requested || []).map((w) => String(w).trim()).filter(Boolean);
  if (outcome !== 'asked') return { owed: words, overridden: false };
  const already = words.length === 1 && words[0].toUpperCase() === 'REVIEWED';
  return { owed: ['REVIEWED'], overridden: !already };
}

/**
 * Run named steps in order; stop, without touching what comes after, the moment one
 * throws. This is the whole of what makes "a refusal exits non-zero naming the step
 * that stopped it and does nothing after it" true rather than a promise in a comment —
 * `bin/b7e-signoff` builds the four real steps and hands them here; `test/signoff.mjs`
 * hands this fakes and asserts the later ones were never called at all.
 *
 * `results` carries every step that *did* run, in order, each `{ name, ok, value }` or
 * `{ name, ok: false, error }` — so a caller can report what landed even when the
 * fourth step is the one that failed. `failedAt` is the step name, or `null` when every
 * step succeeded.
 */
export async function runSteps(steps) {
  const results = [];
  for (const step of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const value = await step.run();
      results.push({ name: step.name, ok: true, value });
    } catch (err) {
      results.push({ name: step.name, ok: false, error: String(err?.message || err) });
      return { results, failedAt: step.name };
    }
  }
  return { results, failedAt: null };
}
