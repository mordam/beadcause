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
 * The MergeAdvocate's queue (lib/mergequeue.js) has had exactly one door into it since
 * bc-r941: `beadcause-deliver`, filing a merge-bead at the end of a worker's session in a
 * space with auto-merge on. Everything else was outside it — a merge the queue handed
 * back, a delivery card in a space that asks rather than merges, a pull request Adam
 * opened himself — and the only thing that could be done with any of those was the
 * **Merge** tap on the phone, which is `pr.merge` and nothing else: no downmerge, no
 * baseline comparison, no one-at-a-time, no other branch's business considered.
 *
 * This is the other door. It does not merge anything. It says *this is approved* and puts
 * the pull request where the queue will find it — and then every gate the queue has still
 * applies, which is the entire point: an approval says the change is wanted, not that it
 * works. A branch that broke a check comes back as a card with the approval still on it.
 *
 * ## Why it is a command and not a button
 *
 * The button exists and is right for what it does — a person looking at a card on a
 * phone, deciding. This is the same decision made in the place the work was actually
 * reviewed: a session, in the checkout, with the diff in front of it. `/merge` in Claude
 * Code is a wrapper around this, and the reason the logic is here rather than in the
 * skill is that a skill is prose a model interprets — where relabelling a bead into
 * somebody else's queue is the kind of thing that must happen the same way every time or
 * not at all. lib/mergeadmit.js decides, this does the writes, and the skill supplies the
 * pull request and Adam's word.
 *
 * ## What it writes, and in what order
 *
 * Three writes at most, ordered so that a failure part-way leaves a state somebody can
 * see rather than a bead that is half in two queues:
 *
 * 1. **The bead's own state** — labels, and the queue block with the approval in it. This
 *    is the write that matters; everything else is a courtesy.
 * 2. **The assignee**, because `queueFor` selects on it and a bead with the label and the
 *    wrong owner is invisible to the queue in a way that looks exactly like being queued.
 * 3. **The comment**, and the note on the pull request. The record of who said this could
 *    land, which is the question anybody has about a merge six months later.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ownAddresseeLabels } from '../lib/addressee.js';
import { Bd } from '../lib/bd.js';
import { loadConfig } from '../lib/config.js';
import { deliveryBlock } from '../lib/delivery.js';
import { admitComment, admitPlan } from '../lib/mergeadmit.js';
import { MERGE_ASSIGNEE, MERGE_LABEL, mergeBeadBody, mergeBeadTitle, withQueueBlock } from '../lib/mergebead.js';
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

const comment = admitComment(plan, { by: owner });

if (plan.action === 'file') {
  /**
   * Nothing in the tracker is about this pull request, so the queue entry is made here —
   * the same bead `beadcause-deliver` files, with the block built from what GitHub says
   * rather than from what a session did, because there was no session.
   *
   * The work bead is optional and usually absent: this is the case where Adam opened the
   * pull request himself. `finish` in lib/mergequeue.js already handles a block that
   * names no bead — it closes the queue entry and stops — so the absence needs no
   * special handling anywhere but in the body, which must not claim to be closing a bead
   * that does not exist.
   */
  const delivery = {
    workspace: ws.name,
    bead: beadFlag,
    repo: slug,
    number,
    url: view.url,
    branch: view.branch,
    base: view.base,
    method: String(cfg.pr?.mergeMethod || 'merge'),
    title: view.title,
    summary: `Admitted to the merge queue by ${owner}.`,
    tests: '',
    risk: '',
    left: '',
  };

  const body = beadFlag
    ? mergeBeadBody(delivery, {})
    : [
        `**${slug || ws.name}** — pull request [#${number}](${view.url}) was admitted to the merge queue by ` +
          `${owner}, and no work bead is named on it.`,
        '',
        `The queue brings \`${view.base}\` into \`${view.branch}\`, checks whatever \`${view.base}\` is not ` +
          `already failing, merges, and closes this bead. Nothing else closes with it.`,
        '',
        '_What the merge acts on, in the form the server reads it:_',
        deliveryBlock(delivery),
      ].join('\n');

  let filed;
  try {
    filed = await bd.create(ws, {
      title: mergeBeadTitle(delivery),
      body,
      type: 'task',
      // Above the work it gates, as bin/deliver.js files it, so a queue that is behind is
      // visible on the board rather than buried under the beads waiting on it.
      priority: 1,
      // Whose merge this is, when a tracker is shared — the same labels
      // `beadcause-deliver` puts on the merge-bead it files, and nothing at all on a
      // single-person install. Without them a queue entry filed into the Climative graph
      // belongs to nobody.
      labels: [...plan.addLabels, ...ownAddresseeLabels(cfg)],
      notes: withQueueBlock('', plan.state),
    });
  } catch (err) {
    die(`could not file a merge-bead in ${ws.name} — ${first(err)}`, 5);
  }
  // `Bd.create` answers with the id itself.
  const id = typeof filed === 'string' ? filed : filed?.id;
  if (!id) die(`filed a merge-bead in ${ws.name} but bd said nothing about which`, 5);

  try {
    await bd.assign(ws, id, MERGE_ASSIGNEE);
  } catch (err) {
    die(`filed ${id}, but could not assign it to ${MERGE_ASSIGNEE} — the queue will not see it (${first(err)})`, 5);
  }

  if (beadFlag) {
    // The work bead waits behind the queue entry, which is what stops anything closing it
    // while the branch is still in a pull request — the same dependency bin/deliver.js
    // makes, and the whole mechanism by which the merge is what finishes the work.
    try {
      await bd.addDep(ws, beadFlag, id);
    } catch (err) {
      console.error(`beadcause-merge: ${beadFlag} is NOT parked behind ${id} — ${first(err)}`);
    }
  }

  await bd.comment(ws, id, comment).catch((err) => console.error(`beadcause-merge: ${id} took no comment — ${first(err)}`));
  await pr
    .comment(dir, number, `${owner} admitted this to the beadcause merge queue as ${id}. The queue merges it once its gates pass.`)
    .catch((err) => console.error(`beadcause-merge: could not comment on ${where} — ${first(err)}`));

  console.log(`queued ${where} ${view.url} ${id}`);
  process.exit(0);
}

/* An existing bead: relabelled and re-armed, or simply told about the approval. */

const spec = plan.spec;
const row = rows.find((r) => r.id === plan.id) || {};

/**
 * The description goes back to being a queue entry's, and only on `admit`.
 *
 * A raised card's body is written to be answered — *it could not merge, so it is yours,
 * answering Merge merges it* — and leaving that on a bead that is back in the queue is a
 * bead whose own description tells the next reader to do something nobody is going to do.
 * `mergeBeadBody` is the other half of the same pair, from the same `beadpr` block, so
 * the round trip is lossless.
 *
 * The **title** is deliberately left alone. A delivery card's title is the question it
 * asked, a merge-bead's is `Merge #N — bead: what`, and rewriting one into the other
 * would rename a bead in the middle of somebody's board for no gain — the label is what
 * says which of the two it is now.
 */
const description =
  plan.action === 'admit' ? mergeBeadBody({ ...spec, title: row.title || '' }, { tests: spec.tests || '' }) : undefined;

try {
  await bd.update(ws, plan.id, {
    description,
    notes: withQueueBlock(row.notes || '', plan.state),
    addLabels: plan.addLabels,
    removeLabels: plan.removeLabels,
  });
} catch (err) {
  die(`could not put ${plan.id} back on the queue — ${first(err)}`, 5);
}

if (plan.assignee) {
  try {
    await bd.assign(ws, plan.id, plan.assignee);
  } catch (err) {
    die(
      `${plan.id} carries the ${MERGE_LABEL} label now, but could not be assigned to ${plan.assignee} — ` +
        `the queue selects on the assignee, so it will not pick this up until that is fixed (${first(err)})`,
      5
    );
  }
}

await bd.comment(ws, plan.id, comment).catch((err) => console.error(`beadcause-merge: ${plan.id} took no comment — ${first(err)}`));

if (plan.action === 'admit') {
  await pr
    .comment(dir, number, `${owner} approved this. It is back on the beadcause merge queue as ${plan.id}.`)
    .catch((err) => console.error(`beadcause-merge: could not comment on ${where} — ${first(err)}`));
}

console.log(`${plan.action === 'approve' ? 'approved' : 'queued'} ${where} ${view.url} ${plan.id}`);
