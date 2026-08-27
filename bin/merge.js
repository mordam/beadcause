#!/usr/bin/env node
/**
 * `beadcause-merge` — hand a pull request Adam has approved to the merge queue.
 *
 * bc-okja.
 *
 *     beadcause-merge                     # the pull request for this checkout's branch
 *     beadcause-merge 349                 # by number, in this checkout's repo
 *     beadcause-merge https://github.com/…/pull/349
 *     beadcause-merge --bead bc-okja      # by the work bead it carries
 *     beadcause-merge -n                  # say what it would do, write nothing
 *
 * The MergeAdvocate's queue (lib/mergequeue.js) had exactly one door into it after
 * bc-r941: `beadcause-deliver`, filing a merge-bead at the end of a worker's session in a
 * space with auto-merge on. Everything else was outside it — a merge the queue handed
 * back, a delivery card in a space that asks rather than merges, a pull request Adam
 * opened himself — and the only thing that could be done with any of those was the
 * **Merge** tap on the phone, which was `pr.merge` and nothing else: no downmerge, no
 * baseline comparison, no one-at-a-time, no other branch's business considered.
 *
 * This is the second door, and since bc-02ldo that tap is a third one onto the same
 * function rather than a way round it. It does not merge anything. It says *this is approved* and puts
 * the pull request where the queue will find it — and then every gate the queue has still
 * applies, which is the entire point: an approval says the change is wanted, not that it
 * works. A branch that broke a check comes back as a card with the approval still on it.
 *
 * ## Why there is a command as well as a button
 *
 * The button and this are the same act now — bc-02ldo. Until then the button was
 * `pr.merge` straight through, no bead and no queue behind it, and the two doors into
 * `main` disagreed about what merging even was. What is left here that is not there is
 * only what a *checkout* knows: which workspace this directory belongs to, which pull
 * request the branch you are standing on names, and Adam's `-b`. `/merge` in Claude Code
 * is a wrapper around this, and the reason the logic is here rather than in the skill is
 * that a skill is prose a model interprets — where relabelling a bead into somebody
 * else's queue is the kind of thing that must happen the same way every time or not at
 * all.
 *
 * So: **lib/mergeadmit.js decides and writes**, this supplies the pull request from a
 * checkout, and the skill supplies Adam's word. What the writes are, in what order, and
 * which of them may fail without failing the admission, is documented on `admitToQueue`
 * there — beside the plan it executes, rather than in one of its two callers.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bd } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { admitPlan, admitToQueue } from '../lib/mergeadmit.js';
import { ownerName } from '../lib/owner.js';
import * as pr from '../lib/pr.js';
import { repoUnits } from '../lib/repos.js';
import { resolveSessionDir } from '../lib/session.js';

const argv = process.argv.slice(2);
/** Flags that swallow the token after them, so a positional is never one of their values. */
const TAKES_VALUE = new Set(['--workspace', '-w', '--bead', '-b', '--dir', '--method']);

function arg(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i > -1) return argv[i + 1];
  }
  return undefined;
}
const has = (...names) => names.some((n) => argv.includes(n));

/** The first bare word — a number, or a pull request URL. */
function positional() {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('-')) {
      if (TAKES_VALUE.has(tok)) i += 1;
      continue;
    }
    return tok;
  }
  return '';
}

const die = (msg, code = 1) => {
  console.error(`beadcause-merge: ${msg}`);
  process.exit(code);
};
const first = (err) => String(err?.message || err || '').split('\n')[0];

if (has('--help', '-h')) {
  console.log(
    'usage: beadcause-merge [<number>|<url>] [-w <workspace>] [-b <bead>] [--dir <checkout>] [--dry-run]\n' +
      '\n' +
      'Admits a pull request to the beadcause merge queue as approved. It does not merge:\n' +
      'the queue downmerges, judges the checks against what the base is already failing,\n' +
      'merges, and closes the work bead and the queue entry together.'
  );
  process.exit(0);
}

const cfg = loadConfig();
const owner = ownerName(cfg);
const dir = path.resolve(arg('--dir') || process.cwd());
const beadFlag = String(arg('--bead', '-b') || '').trim() || null;
const dryRun = has('--dry-run', '-n');
const at = new Date().toISOString();

const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();

/* ------------------------------------------------------------------ the workspace */

/**
 * Which workspace this checkout belongs to, worked out rather than asked for.
 *
 * `beadcause-deliver` takes `-w` because it is invoked by a session brief that already
 * knows the answer. This is typed by a person, or by a skill standing in a worktree, and
 * the answer is in front of it: the checkout's **common** git directory — `git rev-parse
 * --git-common-dir`, the same call `unitKeyHere` makes in bin/deliver.js — is the main
 * checkout even when this is a worktree of it, and every workspace on this Mac resolves
 * to exactly one directory through the same function the daemon uses.
 *
 * `-w` still wins, for the case this cannot answer: a repo that is in no workspace, and a
 * checkout that is not where the config says the workspace lives.
 */
function workspaceHere() {
  let common = path.resolve(dir);
  try {
    common = path.resolve(dir, git(['rev-parse', '--git-common-dir']), '..');
  } catch {
    /* not a checkout — reported by finding nothing */
  }
  for (const ws of cfg.workspaces || []) {
    for (const unit of repoUnits(cfg, ws.name)) {
      let where = '';
      try {
        where = unit.repo ? unit.repo.dir : resolveSessionDir(cfg, ws);
      } catch {
        continue;
      }
      if (where && path.resolve(where) === common) return ws;
    }
  }
  return null;
}

const wsName = arg('--workspace', '-w');
const ws = wsName ? (cfg.workspaces || []).find((w) => w.name === wsName) : workspaceHere();
if (!ws) {
  die(
    wsName
      ? `no workspace called ${wsName} — ${(cfg.workspaces || []).map((w) => w.name).join(', ')}`
      : `${dir} is not a checkout of any workspace on this Mac — name one with -w ` +
          `(${(cfg.workspaces || []).map((w) => w.name).join(', ')})`
  );
}

/* ----------------------------------------------------------------- the pull request */

const gh = await pr.available();
if (!gh.ok) die(gh.reason, 4);

const target = positional();
const fromUrl = Number((String(target).match(/\/pull\/(\d+)/) || [])[1] || NaN);
let number = Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : Number(target);

if (!Number.isInteger(number) || number <= 0) {
  // No number given: the pull request for the branch this checkout is on, which is what a
  // session that has just pushed one is standing in.
  let branch = '';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (err) {
    die(`${dir} is not a git checkout — ${first(err)}`);
  }
  if (branch === 'HEAD') die('this checkout is on a detached head, so it names no pull request');
  const forBranch = await pr.viewForBranch(dir, branch).catch(() => null);
  if (!forBranch?.number) {
    die(`no open pull request for \`${branch}\` in ${dir} — give the number, or the URL`, 3);
  }
  number = forBranch.number;
}

let view;
try {
  view = await pr.view(dir, number);
} catch (err) {
  die(`could not read #${number} in ${dir} — ${first(err)}`, 4);
}

const where = `#${number}`;
if (String(view.state || '').toUpperCase() !== 'OPEN') {
  // Not a failure worth an angry exit code on the merged side: "it is already in" is the
  // outcome the caller wanted, arrived at without them. A closed one is not.
  if (view.mergedAt) {
    console.log(`already merged ${where} ${view.url}${view.mergeCommit ? ` as ${String(view.mergeCommit).slice(0, 8)}` : ''}`);
    process.exit(0);
  }
  die(`${where} is closed and was never merged — reopen it before it can go on the queue`, 3);
}
if (view.draft) die(`${where} is a draft, and GitHub will not merge one — mark it ready first`, 3);

const slug = await pr.slugFor(dir).catch(() => '');

/* ------------------------------------------------------------------------ the plan */

const bd = new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me });

let rows;
try {
  rows = await bd.listLive(ws);
} catch (err) {
  die(`could not read the ${ws.name} tracker — ${first(err)}`, 5);
}

const plan = admitPlan(rows, { repo: slug, number, bead: beadFlag, by: owner, at });

if (plan.others.length) {
  // Never silent: two open beads about one pull request is a pile that blocks the work
  // bead's close, and the one this did not pick stays open with nobody looking at it.
  console.error(
    `beadcause-merge: ${plan.others.join(', ')} ${plan.others.length === 1 ? 'is' : 'are'} also open about ${where} — ` +
      `this acted on ${plan.id || 'a new bead'}, and ${plan.others.length === 1 ? 'that one' : 'those'} should be closed or superseded`
  );
}

if (dryRun) {
  console.log(`${plan.action} ${where} ${plan.id || '(a new merge-bead)'} — ${plan.why}`);
  process.exit(0);
}

/* ---------------------------------------------------------------------- the writes */

/**
 * All of them, in lib/mergeadmit.js — and this file no longer knows what they are.
 *
 * They lived here until bc-02ldo, which is the bead about the app's Merge button doing
 * something else entirely. Making the button queue meant a second caller for this exact
 * sequence, and two copies of it is two copies that drift, so the sequence moved next to
 * the decision that describes it and both doors call the one function.
 */
let done;
try {
  done = await admitToQueue(bd, ws, plan, {
    cfg,
    view,
    repo: slug,
    bead: beadFlag,
    method: String(cfg.pr?.mergeMethod || 'merge'),
    by: owner,
    rows,
    prComment: (n, text) => pr.comment(dir, n, text),
    onWarn: (msg) => console.error(`beadcause-merge: ${msg}`),
  });
} catch (err) {
  die(first(err), err?.code || 5);
}

console.log(`${done.action === 'approve' ? 'approved' : 'queued'} ${where} ${view.url} ${done.id}`);
