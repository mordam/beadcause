#!/usr/bin/env node
/**
 * Hand finished work back as a pull request.
 *
 *   beadcause-deliver -w beadcause -b bc-7qo --tests "npm test — 42 passing" < summary.md
 *
 * This is how a session ends now. It used to end by merging into main on this laptop
 * and closing its bead, which meant the first time Adam saw a change was in `git log`,
 * after it had shipped — and that only worked at all because he was the only one who
 * ever merged. With several sessions a day it stopped working: they raced each other
 * into main, and every conflict landed on him anyway, in the worst possible form.
 *
 * So the session's last act is this, and it does three things in one:
 *
 * 1. Pushes the branch. **Only ever a branch** — this refuses to run on main, and
 *    nothing in beadcause can push to main at all.
 * 2. Opens the pull request, or finds the one already open for the branch, which is
 *    the ordinary case on the second delivery after changes were requested.
 * 3. Files the question whose *answer* is the merge, and parks the work bead behind
 *    it, so nothing picks the bead up again while it is waiting on a decision.
 *
 * Prints `<question-id> <pr-url>`. Exits non-zero, loudly, on every condition where
 * carrying on would produce a PR that misrepresents what is in the branch — a dirty
 * tree, no commits, a detached head.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { ownerName } from '../lib/owner.js';
import { deliveryBody, deliveryTitle, DELIVERY_LABEL } from '../lib/delivery.js';
import * as pr from '../lib/pr.js';

function arg(...names) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i > -1) return process.argv[i + 1];
  }
  return undefined;
}
const has = (n) => process.argv.includes(n);

const die = (msg, code = 1) => {
  console.error(`beadcause-deliver: ${msg}`);
  process.exit(code);
};

const cfg = loadConfig();
// What the pull request body and the argument errors call whoever is reviewing this.
const owner = ownerName(cfg);
const wsName = arg('--workspace', '-w');
const beadId = arg('--bead', '-b');
const base = arg('--base') || 'main';
const method = (arg('--method') || 'squash').toLowerCase();
const tests = arg('--tests') || '';
const risk = arg('--risk') || '';
const left = arg('--left') || '';
const titleArg = arg('--title', '-t');
const summaryFile = arg('--file', '-f');
const dir = path.resolve(arg('--dir') || process.cwd());

const ws = cfg.workspaces.find((w) => w.name === wsName);
if (!ws || !beadId || has('--help') || has('-h')) {
  console.error('usage: beadcause-deliver -w <workspace> -b <bead> [--base main] [--method squash] [--tests "..."] [-f summary.md]');
  console.error(`workspaces: ${cfg.workspaces.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();

/* ---------------------------------------------------------------- the branch */

let branch;
try {
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
} catch (err) {
  die(`${dir} is not a git checkout — ${String(err.message).split('\n')[0]}`);
}
if (branch === 'HEAD') die('this checkout is on a detached head; a PR needs a branch');
if (['main', 'master', base].includes(branch)) {
  die(`refusing to open a PR from ${branch} into ${base} — the work should be on its own branch`);
}

// A dirty tree is the one failure worth being rude about: the PR would describe work
// that is on this laptop and nowhere else, and it would look complete.
const dirty = git(['status', '--porcelain']);
if (dirty) {
  die(`the worktree has uncommitted changes — commit them first, they are not in the PR:\n${dirty}`, 2);
}

// Commits against the base as the remote has it, not as this laptop last saw it.
try {
  git(['fetch', 'origin', base, '--quiet']);
} catch {
  /* offline, or no such remote branch. The count below is then against the local ref. */
}
const upstream = git(['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : base;
const ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`]));
if (!ahead) die(`${branch} has no commits that ${upstream} does not — there is nothing to deliver`, 2);

/* ------------------------------------------------------------------- the bead */

const env = { ...process.env, BEADS_DIR: ws.dir, BEADS_ACTOR: cfg.actor };
const bd = (args) => execFileSync(cfg.bdBin, args, { env, cwd: ws.dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

let bead = null;
try {
  const rows = JSON.parse(bd(['show', beadId, '--json']));
  bead = (Array.isArray(rows) ? rows : rows?.issues || [])[0] || null;
} catch {
  /* Reported below — a delivery for a bead that does not exist is a typo, not a state. */
}
if (!bead) die(`no bead ${beadId} in the ${ws.name} workspace`);

const summary = summaryFile ? fs.readFileSync(summaryFile, 'utf8') : fs.readFileSync(0, 'utf8').trim();
if (!summary) die(`a summary is required — it is the whole of what ${owner} reads before merging`, 2);

const title = titleArg || `${beadId}: ${bead.title || branch}`;

/* --------------------------------------------------------------------- github */

const gh = await pr.available();
if (!gh.ok) die(gh.reason, 4);

// Push before asking GitHub anything: `gh pr create` on an unpushed branch offers an
// interactive prompt, and there is nobody at this keyboard to answer it.
try {
  git(['push', '--set-upstream', 'origin', `${branch}:${branch}`]);
} catch (err) {
  die(`could not push ${branch} — ${String(err.message).split('\n').slice(-2).join(' ')}`, 5);
}

const prBody = [
  `Closes ${beadId} once merged.`,
  '',
  summary,
  tests ? `\n**Tests:** ${tests}` : '',
  risk ? `\n**Worth knowing:** ${risk}` : '',
  left ? `\n**Left undone:** ${left}` : '',
  '',
  '---',
  `_Opened by a beadcause worker session on ${beadId}. It is not merged until ${owner} answers the question in their inbox._`,
]
  .filter((l) => l !== '')
  .join('\n');

// The second delivery on a branch is the ordinary case, not the exception: changes
// were requested, the session pushed more commits, and the PR is still open. Reusing
// it keeps the review thread in one place.
let request = await pr.viewForBranch(dir, branch);
if (request && request.state !== 'OPEN') request = null;
if (request) {
  await pr.comment(dir, request.number, `**Updated** — ${ahead} commit${ahead === 1 ? '' : 's'} on \`${branch}\`.\n\n${summary}`);
} else {
  try {
    request = await pr.create(dir, { base, head: branch, title, body: prBody });
  } catch (err) {
    die(`gh pr create failed — ${err.message}`, 5);
  }
}

/* ----------------------------------------------------------- the question bead */

const delivery = {
  workspace: ws.name,
  bead: beadId,
  repo: await pr.slugFor(dir),
  number: request.number,
  url: request.url,
  branch,
  base,
  method: ['squash', 'merge', 'rebase'].includes(method) ? method : 'squash',
  title: request.title,
  summary,
  tests,
  risk,
  left,
};

const out = bd([
  'create',
  '--title',
  deliveryTitle(delivery),
  '--type',
  'task',
  '--priority',
  '1',
  '--label',
  'human',
  '--label',
  DELIVERY_LABEL,
  '--description',
  deliveryBody(delivery, {
    context: `**${request.files ?? 0} file${request.files === 1 ? '' : 's'}**, +${request.additions ?? 0} −${request.deletions ?? 0}, ${ahead} commit${ahead === 1 ? '' : 's'}.`,
  }),
  '--json',
]);
const created = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
const questionId = created.id || created.issue?.id;

// The work bead waits behind the question. Without this the advocate's next tick sees
// a bead that is open and unblocked, and opens a second session onto work that is
// already sitting in a PR — the exact duplication the whole channel exists to stop.
try {
  bd(['dep', 'add', beadId, questionId]);
} catch (err) {
  console.error(`beadcause-deliver: filed ${questionId}, but could not park ${beadId} behind it — ${String(err.message).split('\n')[0]}`);
}

try {
  bd(['comment', beadId, `Delivered as [#${request.number}](${request.url}) on \`${branch}\`. Waiting on ${questionId} for the merge.`]);
} catch {
  /* The comment is a courtesy; the dependency above is the part that matters. */
}

console.log(`${questionId} ${request.url}`);
