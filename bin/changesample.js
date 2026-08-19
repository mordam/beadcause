#!/usr/bin/env node
/**
 * The change-management sample as a command — SOC 2 CC8.1 and ISO/IEC 27001 A.8.32
 * evidence for an arbitrary window, produced without a human assembling anything.
 *
 *   beadcause-changes sample [--from 2026-04-01] [--to 2026-07-01] [--size 25] [--seed 7]
 *   beadcause-changes all    [--from …] [--to …]        the whole period, not a sample
 *   beadcause-changes summary [--from …] [--to …]       one line, for a log or a check
 *
 * The artefact this exists for is the first one: an auditor names a period and a sample
 * size, and gets back a document with one row per sampled change and, for each, where the
 * authorisation, the design, the development, the test, the approval and the deployment
 * record actually are. `--seed` is what makes it *their* sample rather than ours — the
 * selection is a pure function of the seed and the commit hash, so they choose the seed,
 * we cannot steer which changes come out, and re-running it a year later returns the same
 * rows. See the header of lib/changesample.js for why that matters more than it sounds.
 *
 * **It reads. It writes nothing** — not the tracker, not the repository, not a ref. An
 * evidence tool that mutated the thing it was evidencing would be the one tool in this
 * repository nobody could use during fieldwork.
 *
 * `--json` for the whole payload, `--out <file>` to write the markdown somewhere an
 * auditor can be sent a link to. Both are the same computation; the rendering is the only
 * difference, which is what stops the readable artefact and the machine-readable one ever
 * disagreeing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { Bd } from '../lib/bd.js';
import { ownWorkspace } from '../lib/deploy.js';
import { mainCheckout } from '../lib/gitref.js';
import { collect } from '../lib/changegather.js';
import { describeSample, renderReport } from '../lib/changesample.js';

const argv = process.argv.slice(2);
const [verb = 'sample'] = argv;

function arg(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i > -1) return argv[i + 1];
  }
  return undefined;
}
const has = (n) => argv.includes(n);
const warn = (msg) => console.error(`beadcause-changes: ${msg}`);

if (has('--help') || has('-h') || !['sample', 'all', 'summary'].includes(verb)) {
  console.error(
    [
      'beadcause-changes sample  [-w <workspace>] [--from <date>] [--to <date>] [--size 25] [--seed 1]',
      'beadcause-changes all     [-w <workspace>] [--from <date>] [--to <date>]',
      'beadcause-changes summary [-w <workspace>] [--from <date>] [--to <date>]',
      '',
      '  --branch <name>   which branch is the record of what shipped (default: main)',
      '  --dir <path>      the checkout to read, when it is not the one you are standing in',
      '  --json            the whole payload, rather than the report',
      '  --out <file>      write the report to a file as well as saying where it went',
      '',
      'Dates are anything `git log --since` takes: 2026-04-01, "3 months ago", "last monday".',
    ].join('\n')
  );
  process.exit(has('--help') || has('-h') ? 0 : 1);
}

const cfg = loadConfig();
const workspaces = cfg.workspaces || [];

const dir = arg('--dir') || process.cwd();

/**
 * Which workspace's tracker holds the beads for the checkout being read: named, else
 * inferred from where the command was run, else the only one there is.
 *
 * Two indirections, and both are load-bearing. **`workspace.dir` is the tracker, not the
 * checkout** — `~/beads/beadcause/.beads` for a repository at
 * `~/neadamthal.projects/beadcause` — so comparing the cwd against it finds nothing,
 * ever; `ownWorkspace` in lib/deploy.js is that lookup done right, including the
 * multi-repo case where forty approved checkouts share one tracker. And **it wants a
 * checkout root**, where this is run from wherever somebody is standing, which in this
 * repository is usually a worktree — so `mainCheckout` normalises first, since git's
 * common dir resolves a worktree back to the checkout that owns it.
 */
async function resolveWorkspace() {
  const named = arg('--workspace', '-w');
  if (named) return workspaces.find((w) => w.name === named) || null;
  const root = (await mainCheckout(path.resolve(dir)).catch(() => null)) || path.resolve(dir);
  const name = ownWorkspace(cfg, root);
  if (name) return workspaces.find((w) => w.name === name) || null;
  return workspaces.length === 1 ? workspaces[0] : null;
}

const ws = await resolveWorkspace();

// Not fatal, and deliberately so. A checkout with no workspace still has a complete
// population — git holds that — and a report of six `unknown` columns over a real list of
// changes is a true statement about what could be evidenced from here. What would be
// wrong is producing it quietly, so it is said here and again in the report itself.
if (!ws) {
  warn(
    arg('--workspace', '-w')
      ? `no workspace called ${arg('--workspace', '-w')} — known: ${workspaces.map((w) => w.name).join(', ') || 'none'}`
      : 'no workspace matches this directory, so nothing can be asked of the tracker — the report will say so'
  );
}

const size = verb === 'sample' ? Number(arg('--size') ?? 25) : 0;
const seed = arg('--seed') ?? '1';

const result = await collect({
  dir,
  bd: ws ? new Bd({ bin: cfg.bdBin, actor: cfg.actor, sharedServer: cfg.sharedServer, me: cfg.me }) : null,
  workspace: ws,
  branch: arg('--branch') || 'main',
  from: arg('--from') || '',
  to: arg('--to') || '',
  size: Number.isFinite(size) ? size : 25,
  seed,
});

// An empty population reads identically whether the period was quiet or the branch does
// not exist here, and only one of those is a report. `head` tells them apart, so it is
// said before the report rather than left to be inferred from a page of nothing.
if (!result.head) {
  warn(`${dir} has no branch \`${arg('--branch') || 'main'}\` — nothing to sample`);
  // A non-zero status rather than a refusal: the output is still a true report of a window
  // with nothing in it, and a script that checks the code can tell that apart from a quiet
  // quarter without parsing the prose.
  process.exitCode = 2;
}

if (verb === 'summary') {
  console.log(describeSample(result));
  process.exit(process.exitCode || 0);
}

const text = has('--json') ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result);
const out = arg('--out');
if (out) {
  fs.writeFileSync(out, text.endsWith('\n') ? text : `${text}\n`);
  console.log(`${out} — ${describeSample(result)}`);
} else {
  console.log(text);
}
